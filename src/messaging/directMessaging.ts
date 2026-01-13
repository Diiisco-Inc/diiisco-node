import { logger } from '../utils/logger';
import { encode, decode } from 'msgpackr';
import { PubSubMessage } from '../types/messages';
import environment from '../environment/environment';
import { pipe } from 'it-pipe';
import * as lp from 'it-length-prefixed';
import type { Stream } from '@libp2p/interface';
import { peerIdFromString } from '@libp2p/peer-id';

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
    await this.node.handle(this.protocol, async ({ stream, connection }: any) => {
      const peerId = connection.remotePeer.toString();
      logger.debug(`📨 Incoming direct message from ${peerId}`);

      try {
        await this.handleIncomingStream(stream, peerId);
      } catch (err: any) {
        logger.error(`❌ Error handling direct stream: ${err.message}`);
        try {
          await stream.close();
        } catch (closeErr) {
          // Ignore close errors
        }
      }
    });

    logger.info(`✅ Direct messaging protocol registered: ${this.protocol}`);
  }

  /**
   * Handle incoming direct message stream
   */
  private async handleIncomingStream(stream: Stream, peerId: string) {
    const maxSize = environment.directMessaging.maxMessageSize;

    try {
      // Use length-prefixed framing to read message
      const chunks: Uint8Array[] = [];
      let totalSize = 0;

      await pipe(
        stream.source,
        lp.decode(),
        async (source) => {
          for await (const chunk of source) {
            totalSize += chunk.length;
            if (totalSize > maxSize) {
              throw new Error(`Message exceeds max size: ${maxSize} bytes`);
            }
            chunks.push(chunk);
          }
        }
      );

      // Combine chunks
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      // Decode message
      const msg: PubSubMessage = decode(combined);
      logger.info(`📥 Received direct message (${msg.role}) from ${peerId}`);

      // Process through unified handler
      await this.onMessage(msg, peerId);

      // Close stream
      await stream.close();
    } catch (err: any) {
      logger.error(`❌ Error processing direct message: ${err.message}`);
      throw err;
    }
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

      // Create stream to peer - dialProtocol returns { stream }
      const { stream } = await this.node.dialProtocol(
        peerIdObj,
        this.protocol,
        { signal: AbortSignal.timeout(timeout) }
      );

      // Encode message
      const encoded = encode(message);

      // Send with length-prefixed framing
      await pipe(
        [encoded],
        lp.encode(),
        stream.sink
      );

      logger.info(`✅ Direct message sent (${message.role}) to ${peerId.slice(0, 16)}...`);
      return true;
    } catch (err: any) {
      logger.warn(`⚠️ Direct message failed to ${peerId.slice(0, 16)}...: ${err.message}`);
      return false;
    }
  }
}
