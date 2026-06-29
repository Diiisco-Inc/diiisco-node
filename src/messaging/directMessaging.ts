import { logger } from '../utils/logger';
import { encode, decode } from 'msgpackr';
import { PubSubMessage } from '../types/messages';
import environment from '../environment/environment';
import type { Connection, Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { lpStream } from '@libp2p/utils';
import { DEFAULT_DIRECT_MESSAGING_CONFIG } from '../utils/defaults';

// Get direct messaging config with defaults
const directMessagingConfig = environment.directMessaging || DEFAULT_DIRECT_MESSAGING_CONFIG;

export class DirectMessagingHandler {
  private node: any;
  private protocol: string;
  private onMessage: (msg: PubSubMessage, peerId: string) => Promise<void>;

  constructor(node: any, onMessage: (msg: PubSubMessage, peerId: string) => Promise<void>) {
    this.node = node;
    this.protocol = directMessagingConfig.protocol;
    this.onMessage = onMessage;
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

        // Decode message
        const msg: PubSubMessage = decode(messageData);
        logger.info(`📥 Received direct message (${msg.role}) from ${peerId}`);

        // Process through unified handler
        await this.onMessage(msg, peerId);

      }).catch(err => {
        logger.error(`❌ Error handling direct stream: ${err.message}`);
        stream.abort(err);
      });
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

    // If no addresses are known, query the DHT so relay circuit addrs can be discovered
    // before we attempt to dial — otherwise dialProtocol times out doing the same thing.
    if (knownAddrs.length === 0) {
      try {
        logger.info(`🔍 No addresses for ${peerId.slice(0, 16)}..., querying DHT...`);
        const found = await this.node.peerRouting.findPeer(peerIdObj, { signal: AbortSignal.timeout(timeout) });
        knownAddrs = found.multiaddrs.map((a: any) => a.toString());
        logger.info(`🔍 DHT found ${knownAddrs.length} address(es) for ${peerId.slice(0, 16)}...: ${knownAddrs.join(', ')}`);
      } catch (e: any) {
        logger.info(`🔍 DHT lookup failed for ${peerId.slice(0, 16)}...: ${e.message}`);
      }
    }

    try {

      // Dial protocol and get stream
      logger.debug(`🔌 Dialing protocol ${this.protocol} to ${peerId.slice(0, 16)}...`);
      const stream = await this.node.dialProtocol(
        peerIdObj,
        this.protocol,
        { signal: AbortSignal.timeout(timeout) }
      );

      // Encode message
      const encoded = encode(message);

      // Use lpStream to write length-prefixed message
      const lp = lpStream(stream);
      await lp.write(encoded);

      // Close the stream
      await lp.unwrap().close();

      logger.info(`✅ Direct message sent (${message.role}) to ${peerId.slice(0, 16)}...`);
      return true;
    } catch (err: any) {
      const addrList = knownAddrs.length > 0 ? knownAddrs.join(', ') : 'none known';
      const isConnected = this.node.getConnections(peerIdObj).length > 0;
      logger.warn(`⚠️ Direct message failed to ${peerId.slice(0, 16)}... [connected: ${isConnected}, addresses: ${addrList}]: ${err.message}`);
      return false;
    }
  }
}
