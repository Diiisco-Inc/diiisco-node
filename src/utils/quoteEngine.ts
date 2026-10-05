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
    // A quote is a stranger's message and its timer fires later, with nobody to
    // catch what it throws: a malformed one must be refused here, not found by
    // `buildCandidates` a second on, where it would take the process down.
    if (!isValidQuoteResponse(quoteEvent.msg) || typeof quoteEvent.from !== 'string') {
      logger.warn(`❌ Dropped a malformed quote-response from ${String(quoteEvent.from).slice(0, 16)}...`);
      return;
    }

    const event: QuoteEvent = { ...quoteEvent, receivedAt: Date.now() };
    const id = event.msg.id;

    if (!Object.keys(this.quoteQueue).includes(id)) {
      this.quoteQueue[id] = {
        quotes: [event],
        timeout: setTimeout(() => {
          this.closeAuction(id).catch((err) => {
            logger.error(`❌ Could not select a quote for ${id}: ${(err as Error).message}`);
          });
        }, this.waitTime)
      };
    } else {
      this.quoteQueue[id].quotes.push(event);
    }
  }

  // Close the auction for `id`: enrich the quotes (skips on-chain calls in local
  // mode), let the configured strategy pick, and announce the winner. The queue
  // entry is always removed. If nothing can be selected, nothing is emitted and
  // the requester's auction deadline reports that no provider could serve it.
  private async closeAuction(id: string): Promise<void> {
    const quotes = this.quoteQueue[id]?.quotes ?? [];
    delete this.quoteQueue[id];

    const candidates = await this.buildCandidates(quotes);
    if (candidates.length === 0) return;

    const selected = await this.selectQuote(candidates);
    if (!selected) return;

    this.nodeEventEmitter.emit(`quote-selected-${id}`, { msg: selected.msg, from: selected.from });
  }

  // Run the configured selection strategy. Accepts a single function or a list
  // tried in order (the first that returns a candidate wins), defaulting to —
  // and ultimately falling back to — highest staked DSCO.
  private async selectQuote(candidates: QuoteCandidate[]): Promise<QuoteCandidate | undefined> {
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
    const built = await Promise.all(events.map(async (e): Promise<QuoteCandidate | null> => {
      try {
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
      } catch (err) {
        // One quote that cannot be enriched must not sink the rest of the auction.
        logger.warn(`⚠️ Skipping a quote that could not be evaluated: ${(err as Error).message}`);
        return null;
      }
    }));
    return built.filter((c): c is QuoteCandidate => c !== null);
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

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isOptional = (v: unknown, check: (x: unknown) => boolean) => v === undefined || check(v);

/**
 * Whether a `quote-response` has the shape the rest of the engine reads, and
 * claims no stake but its own. Every field `buildCandidates` and the selection
 * strategies touch is checked, so a quote that passes cannot make them throw.
 */
export function isValidQuoteResponse(msg: unknown): msg is QuoteResponse {
  const m = msg as any;
  if (typeof m !== 'object' || m === null) return false;
  // The id keys a plain object: refuse anything that is not an ordinary key.
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > 128 || m.id === '__proto__') return false;
  if (typeof m.fromWalletAddr !== 'string' || !isFiniteNumber(m.timestamp)) return false;
  const q = m.payload?.quote;
  if (typeof q !== 'object' || q === null) return false;
  return (
    typeof q.model === 'string' &&
    // The quote's `addr` is what the engine reads DSCO stake from, and it is
    // self-declared: unless it is the wallet that signed the quote, a peer could
    // borrow another wallet's stake to win the auction.
    q.addr === m.fromWalletAddr &&
    isFiniteNumber(q.pricePerInputToken1M) && q.pricePerInputToken1M >= 0 &&
    isFiniteNumber(q.pricePerOutputToken1M) && q.pricePerOutputToken1M >= 0 &&
    isOptional(q.requestTimestamp, isFiniteNumber) &&
    isOptional(q.settlementMethods, Array.isArray) &&
    isOptional(q.providerPeerId, (v) => typeof v === 'string') &&
    isOptional(q.nfd, (v) => typeof v === 'string')
  );
}
