import { logger } from '../utils/logger';
import { encode, decode } from 'msgpackr';
import { PubSubMessage } from '../types/messages';
import environment from '../environment/environment';
import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';
import { lpStream } from '@libp2p/utils';

export class DirectMessagingHandler {
  private node: any;
  private protocol: string;
  private onMessage: (msg: PubSubMessage, peerId: string) => Promise<void>;

  constructor(node: any, onMessage: (msg: PubSubMessage, peerId: string) => Promise<void>) {
    this.node = node;
    this.protocol = environment.directMessaging.protocol;
    this.onMessage = onMessage;
  }

  /**
   * Register the direct messaging protocol handler
   */
  async registerProtocol() {
    await this.node.handle(this.protocol, (stream: any) => {
      // Handle stream asynchronously (don't block handle registration)
      Promise.resolve().then(async () => {
        // Debug: log stream structure
        logger.debug(`🔍 Stream properties: ${JSON.stringify({
          hasConnection: !!stream.connection,
          hasRemotePeer: !!stream.remotePeer,
          connectionRemotePeer: stream.connection?.remotePeer ? 'exists' : 'missing',
          connectionRemotePeerId: stream.connection?.remotePeerId ? 'exists' : 'missing',
        })}`);

        // Extract peer ID from stream - try multiple approaches for libp2p v3
        let peerId = 'unknown';

        if (stream.connection?.remotePeer) {
          // remotePeer might already be a string or have toString()
          peerId = typeof stream.connection.remotePeer === 'string'
            ? stream.connection.remotePeer
            : stream.connection.remotePeer.toString();
        } else if (stream.remotePeer) {
          peerId = typeof stream.remotePeer === 'string'
            ? stream.remotePeer
            : stream.remotePeer.toString();
        }

        logger.debug(`📨 Incoming direct message from ${peerId}`);

        // Use lpStream to read length-prefixed message
        const lp = lpStream(stream);
        const data = await lp.read();

        // Convert Uint8ArrayList to Uint8Array if needed
        const messageData = data.subarray();

        // Check message size
        if (messageData.length > environment.directMessaging.maxMessageSize) {
          throw new Error(`Message exceeds max size: ${environment.directMessaging.maxMessageSize} bytes`);
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
    const timeout = environment.directMessaging.timeout;

    try {
      // Convert string peerId to PeerId object
      const peerIdObj = peerIdFromString(peerId);

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
      logger.warn(`⚠️ Direct message failed to ${peerId.slice(0, 16)}...: ${err.message}`);
      return false;
    }
  }
}
