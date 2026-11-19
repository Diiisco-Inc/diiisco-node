import { PubSubMessage } from '../types/messages';
import { logger } from '../utils/logger';
import { DirectMessagingHandler } from './directMessaging';
import environment from '../environment/runtime';
import { encode } from 'msgpackr';
import { DEFAULT_DIRECT_MESSAGING_CONFIG } from '../utils/defaults';
import { getMeshTopic } from '../utils/topic';

// Get direct messaging config with defaults
const directMessagingConfig = environment.directMessaging || DEFAULT_DIRECT_MESSAGING_CONFIG;

/**
 * Roles that carry private content: the prompt and tools (`quote-accepted`), the
 * payment challenge and proof, and the completion. They go to one peer over a
 * direct stream and **never** onto the GossipSub topic, which every subscriber
 * can read. If a direct send fails the send fails, and the API layer
 * re-auctions to another provider; falling back to a broadcast would publish
 * the prompt or the answer to the whole mesh.
 */
export const PRIVATE_ROLES: ReadonlySet<string> = new Set([
  'quote-accepted',
  'contract-created',
  'contract-signed',
  'inference-response',
  'inference-failed',
]);

/**
 * Roles sent direct when a route is known but that hold nothing private (a
 * node's public profile), so they may still fall back to GossipSub.
 */
const DIRECT_PREFERRED_ROLES: ReadonlySet<string> = new Set([
  'node-profile',
  'node-profile-response',
]);

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
    return PRIVATE_ROLES.has(message.role) || DIRECT_PREFERRED_ROLES.has(message.role);
  }

  /**
   * Send message using optimal delivery method
   * @param message The message to send
   * @param targetPeerId Optional target peer ID for direct messaging
   */
  async sendMessage(message: PubSubMessage, targetPeerId?: string): Promise<void> {
    const isPrivate = PRIVATE_ROLES.has(message.role);

    if (isPrivate) {
      // Never broadcast. Without a target, a handler or direct messaging
      // switched on, there is nowhere safe to send this.
      if (!targetPeerId || !this.directHandler || !directMessagingConfig.enabled) {
        throw new Error(`Cannot send ${message.role} privately: it needs a target peer and direct messaging enabled, and is never broadcast.`);
      }
      if (await this.directHandler.sendDirect(targetPeerId, message)) return;
      throw new Error(`Direct delivery of ${message.role} to ${targetPeerId} failed; not falling back to broadcast.`);
    }

    const useDirect = this.shouldUseDirect(message) && targetPeerId;

    if (useDirect && this.directHandler) {
      logger.debug(`🎯 Attempting direct delivery for ${message.role}`);

      if (await this.directHandler.sendDirect(targetPeerId!, message)) {
        return; // Successfully sent directly
      }

      // Only non-private roles reach here (see PRIVATE_ROLES).
      if (directMessagingConfig.fallbackToGossipsub) {
        logger.info(`📡 Falling back to GossipSub for ${message.role}`);
        await this.sendViaGossipsub(message);
      } else {
        throw new Error(`Direct message failed and fallback disabled`);
      }
    } else {
      // Discovery-phase messages (and non-private roles with no direct route).
      await this.sendViaGossipsub(message);
    }
  }

  /**
   * Send message via GossipSub broadcast
   */
  private async sendViaGossipsub(message: PubSubMessage): Promise<void> {
    const encoded = encode(message);
    await this.node.services.pubsub.publish(getMeshTopic(), encoded);
    logger.info(`📡 Sent ${message.role} via GossipSub`);
  }
}
