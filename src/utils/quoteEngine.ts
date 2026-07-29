import environment from '../environment/environment'
import { EventEmitter } from 'events'
import { QuoteEvent, QuoteQueueEntry, QuoteRequest, QuoteResponse, QuoteCandidate } from '../types/messages';
import { Environment } from '../environment/environment.types';
import { selectHighestStakeQuote, selectFirstQuote } from './quoteSelectionMethods';
import { OpenAIInferenceModel } from './models';
import { createQuoteFromInputTokens } from './quoteCreationMethods';
import { RawQuote, QuoteSelectionFunction } from '../types/quotes';
import algorand, { verifyNFD } from './algorand';
import diiiscoAssets from './diiiscoAssets';
import { logger } from './logger';

const NFD_CACHE_TTL_MS = 5 * 60_000;

export default class quoteEngine {
  quoteQueue: { [key: string]: QuoteQueueEntry };
  waitTime: number;
  nodeEventEmitter: EventEmitter;
  private algo: algorand;
  private nfdCache: Map<string, { verified: boolean; at: number }> = new Map();

  constructor(nodeEvents: EventEmitter, algo: algorand) {
    this.quoteQueue = {};
    this.waitTime = (environment as Environment).quoteEngine.waitTime || 5000; // default wait time 5 seconds
    this.nodeEventEmitter = nodeEvents;
    this.algo = algo;
  }

  async addQuote(quoteEvent: { msg: QuoteResponse; from: string }) {
    const event: QuoteEvent = { ...quoteEvent, receivedAt: Date.now() };
    const id = event.msg.id;

    if (!Object.keys(this.quoteQueue).includes(id)) {
      this.quoteQueue[id] = {
        quotes: [event],
        timeout: setTimeout(async () => {
          // In local mode always use selectFirstQuote — selectHighestStakeQuote
          // requires live Algorand RPC calls which are not available in local mode.
          const selectionFunction: QuoteSelectionFunction = environment.local?.enabled
            ? selectFirstQuote
            : (environment.quoteEngine.quoteSelectionFunction ?? selectHighestStakeQuote);

          // Enrich once, then let the (pure) strategy pick.
          const candidates = await this.buildCandidates(this.quoteQueue[id].quotes);
          const selected = await selectionFunction(candidates);

          this.nodeEventEmitter.emit(`quote-selected-${id}`, { msg: selected.msg, from: selected.from });

          // Clean up
          delete this.quoteQueue[id];
        }, this.waitTime)
      };
    } else {
      this.quoteQueue[id].quotes.push(event);
    }
  }

  // Attach DSCO balance, NFD status, and response latency to each quote so the
  // selection strategy can stay a pure function of the candidate data.
  private async buildCandidates(events: QuoteEvent[]): Promise<QuoteCandidate[]> {
    return Promise.all(events.map(async (e): Promise<QuoteCandidate> => {
      const quote = e.msg.payload.quote;
      const requestTimestamp = quote.requestTimestamp ?? e.msg.timestamp;
      const responseLatencyMs = Math.max(0, e.receivedAt - requestTimestamp);

      // Prefer the provider's stamped peer id; GossipSub `from` may be a relay.
      const providerPeerId = quote.providerPeerId ?? e.from;
      const [dscoBalance, nfdAuthenticated] = await Promise.all([
        this.providerDsco(e.msg.fromWalletAddr),
        this.providerNfdAuthenticated(providerPeerId, e.msg.fromWalletAddr, quote.nfd),
      ]);

      return {
        quote,
        from: e.from,
        fromWalletAddr: e.msg.fromWalletAddr,
        dscoBalance,
        nfdAuthenticated,
        responseLatencyMs,
        msg: e.msg,
      };
    }));
  }

  // DSCO held by the provider wallet, read on-chain (0 in local mode / on error).
  private async providerDsco(walletAddr: string): Promise<bigint> {
    if (environment.local?.enabled) return 0n;
    try {
      const { balance } = await this.algo.checkIfOptedInToAsset(walletAddr, diiiscoAssets.asset);
      return BigInt(balance.toString());
    } catch (err) {
      logger.warn(`⚠️ Could not read DSCO balance for ${walletAddr}: ${(err as Error).message}`);
      return 0n;
    }
  }

  // Whether the provider's claimed NFD verifies against its peer id + wallet.
  // Cached briefly to avoid re-verifying the same providers on every request.
  private async providerNfdAuthenticated(peerId: string, walletAddr: string, nfd?: string): Promise<boolean> {
    if (environment.local?.enabled || !nfd) return false;
    const key = `${peerId}|${walletAddr}|${nfd}`;
    const cached = this.nfdCache.get(key);
    if (cached && Date.now() - cached.at < NFD_CACHE_TTL_MS) return cached.verified;

    let verified = false;
    try {
      verified = await verifyNFD(peerId, walletAddr, nfd);
    } catch (err) {
      logger.warn(`⚠️ NFD verification failed for ${nfd}: ${(err as Error).message}`);
    }
    this.nfdCache.set(key, { verified, at: Date.now() });
    return verified;
  }

  async createQuote(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel){
    const MIN_PRICE = 0.000001; // 1 microUSDC — smart contract rejects zero-value quotes
    const creationFunctionSetting = environment.quoteEngine.quoteCreationFunction ?? [createQuoteFromInputTokens];
    const creationFunctionArray: Function[] = Array.isArray(creationFunctionSetting) ? creationFunctionSetting : [creationFunctionSetting];

    for (const func of creationFunctionArray){
      const result: RawQuote = await func(quoteRequestMsg, model);
      if (result !== null){
        return { ...result, price: Math.max(result.price, MIN_PRICE) };
      }
    }

    return null
  }
}
