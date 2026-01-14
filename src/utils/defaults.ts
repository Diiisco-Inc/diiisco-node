import type { RelayConfig, DirectMessagingConfig } from '../environment/environment.types';

/**
 * Default relay configuration
 * Used when relay config is not specified in environment
 */
export const DEFAULT_RELAY_CONFIG: RelayConfig = {
  enableRelayServer: true,        // Auto-disabled by AutoNAT if behind NAT
  autoEnableRelay: true,
  maxRelayedConnections: 100,
  enableRelayClient: true,
  enableDCUtR: true,              // Upgrade relayed connections to direct when possible
  maxDataPerConnection: 104857600,  // 100 MB
  maxRelayDuration: 300000,       // 5 minutes
};

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
