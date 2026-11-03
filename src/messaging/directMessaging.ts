import { logger } from '../utils/logger';
import { encode } from 'msgpackr';
import { parseWireMessage } from './wire';
import { PubSubMessage } from '../types/messages';
import environment from '../environment/runtime';
import type { Connection, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { lpStream } from '@libp2p/utils';
import { DEFAULT_DIRECT_MESSAGING_CONFIG } from '../utils/defaults';

// Get direct messaging config with defaults
const directMessagingConfig = environment.directMessaging || DEFAULT_DIRECT_MESSAGING_CONFIG;

/**
 * How long a sender waits for the peer to close its end of a direct message
 * stream before abandoning it. See {@link DirectMessagingHandler.reapWhenSettled}.
 */
export const DEFAULT_STREAM_GRACE_MS = 5000;

/** How long a handler may take to close its end of a stream it has finished with. */
const CLOSE_TIMEOUT_MS = 5000;

/** Errors that mean the stream was closed or reset under us, which a fresh stream may not suffer. */
const isStreamClosedError = (err: any): boolean =>
  ['StreamStateError', 'StreamResetError', 'StreamAbortedError'].includes(err?.name) ||
  /stream that is (closed|closing)|stream (was )?reset/i.test(String(err?.message ?? ''));

export class DirectMessagingHandler {
  private node: any;
  private protocol: string;
  private onMessage: (msg: PubSubMessage, peerId: string) => Promise<void>;
  private streamGraceMs: number;

  constructor(
    node: any,
    onMessage: (msg: PubSubMessage, peerId: string) => Promise<void>,
    options: { streamGraceMs?: number } = {},
  ) {
    this.node = node;
    this.protocol = directMessagingConfig.protocol;
    this.onMessage = onMessage;
    this.streamGraceMs = options.streamGraceMs ?? DEFAULT_STREAM_GRACE_MS;
  }

  /**
   * Close our end of a stream we have finished with. A stream leaves the muxer
   * only once both ends have closed, and libp2p resets any inbound stream past
   * 32 per protocol per connection: a handler that read its message and simply
   * returned left every exchange's stream behind until the peer's sends started
   * failing with "Cannot write to a stream that is closed" (#101). Never throws.
   */
  private async closeStream(stream: Stream): Promise<void> {
    try {
      await stream.close({ signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS) });
    } catch (err: any) {
      try { stream.abort(err); } catch { /* already gone */ }
    }
  }

  /**
   * Abandon a sent stream the peer never closes. A peer on an older build never
   * closes its end, so without this each message would pin an outbound slot
   * here and an inbound slot there. Resetting is safe by now: `close()` has
   * already flushed the message. Never throws, never holds the process open.
   */
  private reapWhenSettled(stream: Stream): void {
    try {
      if (stream.status !== 'open' && stream.status !== 'closing') return;
      const timer = setTimeout(() => {
        try { stream.abort(new Error('direct message stream was not closed by the peer')); } catch { /* already gone */ }
      }, this.streamGraceMs);
      timer.unref?.();
      const settled = () => clearTimeout(timer);
      // 'close' also fires for an abort or a reset: both are StreamCloseEvents.
      stream.addEventListener('close', settled, { once: true });
    } catch { /* best effort */ }
  }

  /** Direct message streams still open to `peerId`; for diagnosing a failure. */
  private openStreams(peerId: any): number {
    try {
      return this.node.getConnections(peerId)
        .flatMap((c: any) => c.streams)
        .filter((s: any) => s.protocol === this.protocol).length;
    } catch {
      return -1;
    }
  }

  /**
   * Register the direct messaging protocol handler
   * In libp2p v3, the handler receives (stream, connection) as separate parameters
   */
  async registerProtocol() {
    await this.node.handle(this.protocol, (stream: Stream, connection: Connection) => {
      // Handle stream asynchronously (don't block handle registration)
      Promise.resolve().then(async () => {
        // Extract peer ID from connection (libp2p v3 pattern)
        const peerId = connection?.remotePeer?.toString() || 'unknown';
        logger.debug(`📨 Incoming direct message from ${peerId}`);

        // Use lpStream to read length-prefixed message
        const lp = lpStream(stream);
        const data = await lp.read();

        // Convert Uint8ArrayList to Uint8Array if needed
        const messageData = data.subarray();

        // Check message size
        if (messageData.length > directMessagingConfig.maxMessageSize) {
          throw new Error(`Message exceeds max size: ${directMessagingConfig.maxMessageSize} bytes`);
        }

        // One message per stream, and it is all here: close our end now so the
        // stream leaves the muxer instead of counting against the 32-stream
        // limit until the connection ends. Anything processing sends goes over
        // a new stream.
        await this.closeStream(stream);

        // Decode message. A stream is untrusted input: drop what is not a message.
        const msg = parseWireMessage(messageData);
        if (!msg) throw new Error('Not a valid DIIISCO message');
        logger.info(`📥 Received direct message (${msg.role}) from ${peerId}`);

        // Process through unified handler
        await this.onMessage(msg, peerId);

      }).catch(err => {
        logger.error(`❌ Error handling direct stream: ${err.message}`);
        stream.abort(err);
      });
    }, {
      // Relayed (circuit) connections are "limited" in libp2p v3 — custom
      // protocols are refused on them unless we opt in here and on the dial.
      runOnLimitedConnection: true,
    });

    logger.info(`✅ Direct messaging protocol registered: ${this.protocol}`);
  }

  /**
   * Send a direct message to a peer
   * @returns true if successful, false if failed
   */
  async sendDirect(peerId: string, message: PubSubMessage): Promise<boolean> {
    const timeout = directMessagingConfig.timeout;
    const peerIdObj = peerIdFromString(peerId);

    let knownAddrs: string[] = [];
    try {
      const knownPeer = await this.node.peerStore.get(peerIdObj);
      knownAddrs = knownPeer.addresses.map((a: any) => a.multiaddr.toString());
    } catch { /* peer not yet in peerstore */ }

    // We deliberately do NOT query the DHT here. NATed peers are DHT clients and
    // are unresolvable via findPeer, so the lookup only stalls for the timeout
    // before failing. Instead we rely on addresses learned from the peer's
    // signed messages (stamped multiaddrs). If we still have no way to reach the
    // peer, bail out immediately and let the caller fall back to GossipSub.
    const isConnected = this.node.getConnections(peerIdObj).length > 0;
    if (knownAddrs.length === 0 && !isConnected) {
      logger.debug(`🔀 No known addresses for ${peerId.slice(0, 16)}... — deferring to GossipSub`);
      return false;
    }

    // A stream can be reset between negotiation and the write (the peer was at
    // its inbound limit, or the connection was recycling). A fresh stream
    // usually works, so try once more before the caller falls back to GossipSub.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await this.sendOnce(peerIdObj, peerId, message, timeout);
        logger.info(`✅ Direct message sent (${message.role}) to ${peerId.slice(0, 16)}...`);
        return true;
      } catch (err: any) {
        if (attempt === 1 && isStreamClosedError(err)) {
          logger.debug(`🔁 Direct message to ${peerId.slice(0, 16)}... hit a closed stream (${err.message}) — retrying on a new stream`);
          continue;
        }
        const addrList = knownAddrs.length > 0 ? knownAddrs.join(', ') : 'none known';
        const isConnected = this.node.getConnections(peerIdObj).length > 0;
        logger.warn(`⚠️ Direct message failed to ${peerId.slice(0, 16)}... [connected: ${isConnected}, addresses: ${addrList}]: ${err?.name ?? 'Error'}: ${err?.message ?? err}`);
        logger.debug(`   open direct streams to this peer: ${this.openStreams(peerIdObj)}`);
        return false;
      }
    }
    return false;
  }

  /** One attempt: open a stream, write the message, close our end. Aborts the stream if anything fails. */
  private async sendOnce(peerIdObj: any, peerId: string, message: PubSubMessage, timeout: number): Promise<void> {
    let stream: Stream | undefined;
    try {
      // Dial protocol and get stream
      logger.debug(`🔌 Dialing protocol ${this.protocol} to ${peerId.slice(0, 16)}...`);
      stream = await this.node.dialProtocol(
        peerIdObj,
        this.protocol,
        // runOnLimitedConnection lets the stream open over a relay circuit
        // (a limited connection); without it the dial is refused.
        { signal: AbortSignal.timeout(timeout), runOnLimitedConnection: true }
      );

      // Encode message
      const encoded = encode(message);

      // Use lpStream to write length-prefixed message
      const lp = lpStream(stream!);
      await lp.write(encoded);

      // Close the stream
      await lp.unwrap().close();

      // The peer closes its end when it has read the message; make sure a peer
      // that does not cannot keep this stream alive.
      this.reapWhenSettled(stream!);
    } catch (err) {
      // A stream we failed on must not keep counting against the limits.
      try { stream?.abort(err as Error); } catch { /* already gone */ }
      throw err;
    }
  }
}
