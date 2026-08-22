import environment from '../environment/runtime'
import { EventEmitter } from 'events'
import { QuoteEvent, QuoteQueueEntry, QuoteRequest, QuoteResponse, QuoteCandidate } from '../types/messages';
import { Environment } from '../environment/environment.types';
import { selectHighestStakeQuote } from './quoteSelectionMethods';
import { OpenAIInferenceModel } from './models';
import { createStandardQuote } from './quoteCreationMethods';
import { RawQuote } from '../types/quotes';
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
          // Enrich once (skips on-chain calls in local mode), then let the
          // configured strategy pick.
          const candidates = await this.buildCandidates(this.quoteQueue[id].quotes);
          const selected = await this.selectQuote(candidates);

          this.nodeEventEmitter.emit(`quote-selected-${id}`, { msg: selected.msg, from: selected.from });

          // Clean up
          delete this.quoteQueue[id];
        }, this.waitTime)
      };
    } else {
      this.quoteQueue[id].quotes.push(event);
    }
  }

  // Run the configured selection strategy. Accepts a single function or a list
  // tried in order (the first that returns a candidate wins), defaulting to —
  // and ultimately falling back to — highest staked DSCO.
  private async selectQuote(candidates: QuoteCandidate[]): Promise<QuoteCandidate> {
    const configured = environment.quoteEngine.quoteSelectionFunction ?? selectHighestStakeQuote;
    const selectors = Array.isArray(configured) ? configured : [configured];
    for (const selector of selectors) {
      try {
        const picked = await selector(candidates);
        if (picked) return picked;
      } catch (err) {
        logger.warn(`⚠️ Quote selector threw, trying next: ${(err as Error).message}`);
      }
    }
    return selectHighestStakeQuote(candidates);
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

  async createQuote(quoteRequestMsg: QuoteRequest, model: OpenAIInferenceModel): Promise<RawQuote | null> {
    // The quote carries per-token rates only; there is no price ceiling to clamp
    // (§4.2). A null result means the request can't be served within the
    // requester's budget, so the provider doesn't quote.
    const createFn = environment.quoteEngine.quoteCreationFunction ?? createStandardQuote;
    return createFn(quoteRequestMsg, model);
  }
}
