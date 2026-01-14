import { PubSubMessage } from '../types/messages';
import { logger } from '../utils/logger';
import { DirectMessagingHandler } from './directMessaging';
import environment from '../environment/environment';
import { encode } from 'msgpackr';
import { DEFAULT_DIRECT_MESSAGING_CONFIG } from '../utils/defaults';

// Get direct messaging config with defaults
const directMessagingConfig = environment.directMessaging || DEFAULT_DIRECT_MESSAGING_CONFIG;

export class MessageRouter {
  private node: any;
  private directHandler: DirectMessagingHandler | null = null;

  constructor(node: any, directHandler: DirectMessagingHandler | null) {
    this.node = node;
    this.directHandler = directHandler;
  }

  /**
   * Determine if a message should use direct messaging
   */
  private shouldUseDirect(message: PubSubMessage): boolean {
    if (!directMessagingConfig.enabled) return false;

    // Post-selection messages go direct
    const directMessageTypes = [
      'quote-accepted',
      'contract-created',
      'contract-signed',
      'inference-response',
    ];

    return directMessageTypes.includes(message.role);
  }

  /**
   * Send message using optimal delivery method
   * @param message The message to send
   * @param targetPeerId Optional target peer ID for direct messaging
   */
  async sendMessage(message: PubSubMessage, targetPeerId?: string): Promise<void> {
    const useDirect = this.shouldUseDirect(message) && targetPeerId;

    if (useDirect && this.directHandler) {
      logger.debug(`🎯 Attempting direct delivery for ${message.role}`);

      // Attempt direct send
      const success = await this.directHandler.sendDirect(targetPeerId!, message);

      if (success) {
        return; // Successfully sent directly
      }

      // Direct failed - try fallback
      if (directMessagingConfig.fallbackToGossipsub) {
        logger.info(`📡 Falling back to GossipSub for ${message.role}`);
        await this.sendViaGossipsub(message);
      } else {
        throw new Error(`Direct message failed and fallback disabled`);
      }
    } else {
      // Use GossipSub for discovery phase messages
      await this.sendViaGossipsub(message);
    }
  }

  /**
   * Send message via GossipSub broadcast
   */
  private async sendViaGossipsub(message: PubSubMessage): Promise<void> {
    const encoded = encode(message);
    await this.node.services.pubsub.publish('diiisco/models/1.0.0', encoded);
    logger.info(`📡 Sent ${message.role} via GossipSub`);
  }
}
