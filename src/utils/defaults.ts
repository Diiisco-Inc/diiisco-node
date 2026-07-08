import type { DirectMessagingConfig } from '../environment/environment.types';

/**
 * Default direct messaging configuration
 * Used when directMessaging config is not specified in environment
 */
export const DEFAULT_DIRECT_MESSAGING_CONFIG: DirectMessagingConfig = {
  enabled: true,
  timeout: 10000,                 // 10 seconds
  fallbackToGossipsub: true,      // Always fallback for reliability
  protocol: '/diiisco/direct/1.0.0',
  maxMessageSize: 10485760,       // 10 MB
};
