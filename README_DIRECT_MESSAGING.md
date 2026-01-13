# Direct Messaging & Circuit Relay Guide

## Overview

DIIISCO nodes now support a **hybrid messaging approach** that optimizes network performance:

- **Quote Discovery Phase**: Uses GossipSub (broadcast) to find available providers
- **Post-Selection Phase**: Uses direct peer-to-peer streams for faster, private communication
- **Automatic Fallback**: Reverts to gossipsub if direct messaging fails
- **Backward Compatible**: Maintains compatibility with nodes running older versions

## Backward Compatibility

The implementation maintains **full backward compatibility**:

- When `directMessaging.enabled = false`: Uses the **original pubsub handler**
- When `directMessaging.enabled = true`: Uses the **new unified message processor** with direct messaging support

This ensures nodes with direct messaging **disabled** can still communicate with nodes running the old codebase via gossipsub.

## Key Features

### ✅ Direct Messaging
- Peer-to-peer streams for post-selection messages
- 50-80% latency reduction compared to gossipsub
- ~80% bandwidth savings by eliminating broadcast overhead
- Enhanced privacy - contract details not broadcast to entire network

### ✅ Circuit Relay Support
- Nodes behind NAT/firewalls can communicate via relay servers
- Automatic relay server functionality on nodes with open ports
- DCUtR (Direct Connection Upgrade through Relay) for optimal performance

### ✅ AutoNAT Detection
- Automatic detection of network accessibility
- Nodes auto-configure as relay servers if publicly accessible
- Graceful degradation to relay client mode if behind NAT

## Configuration

### Relay Configuration

Add to your `environment.ts`:

```typescript
relay: {
  enableRelayServer: true,           // Act as relay for other nodes
  autoEnableRelay: true,              // Auto-detect based on NAT status
  maxRelayedConnections: 100,         // Concurrent relayed connections limit
  enableRelayClient: false,           // Disabled by default (enable if needed)
  enableDCUtR: false,                 // Disabled by default (enable if needed)
  maxDataPerConnection: 104857600,    // 100 MB per relayed connection
  maxRelayDuration: 300000,           // 5 minutes max duration
}
```

**⚠️ Important**: `enableRelayClient` and `enableDCUtR` are disabled by default to maintain backward compatibility with nodes running older versions. These features add circuit relay transport which changes connection behavior. Enable them only after all nodes in your network are upgraded.

### Direct Messaging Configuration

```typescript
directMessaging: {
  enabled: true,                      // Enable direct messaging
  timeout: 10000,                     // Direct message timeout (ms)
  fallbackToGossipsub: true,          // Fallback if direct fails
  protocol: '/diiisco/direct/1.0.0',  // Protocol identifier
  maxMessageSize: 10485760,           // 10 MB max message size
}
```

## Network Topologies

### Public Server (Open Ports)

Ideal for:
- Bootstrap nodes
- High-availability providers
- Relay servers

Configuration:
- Automatically acts as relay server (via AutoNAT detection)
- Receives direct connections from all nodes
- Helps with NAT traversal for client nodes

**Firewall Setup:**
```bash
# Allow TCP port
sudo ufw allow 4242/tcp

# Or use custom port
export DIIISCO_PORT=5000
```

### Behind NAT/Firewall

Ideal for:
- Local development
- Home/office networks
- Restricted environments

How it works:
- Connects to relay servers automatically  
- Attempts DCUtR for direct connection upgrades
- Falls back to gossipsub when needed

**No additional configuration required** - relay client mode is enabled by default.

## Message Flow

### Phase 1: Quote Discovery (GossipSub)

```
Client → GossipSub: quote-request (broadcast)
   ↓
Providers → Client: quote-response (via gossipsub)
   ↓
Client: Selects best quote locally
```

### Phase 2: Contract & Inference (Direct)

```
Client → Provider: quote-accepted (direct stream)
   ↓
Provider → Client: contract-created (direct stream)
   ↓
Client → Provider: contract-signed (direct stream)
   ↓
Provider → Client: inference-response (direct stream)
```

### Fallback Behavior

If direct messaging fails:
1. Try direct connection
2. Try relayed connection (via circuit relay)
3. Fall back to gossipsub (if enabled)

## Monitoring

### Message Statistics

View messaging stats in the logs (logged every minute):

```
📊 Messaging Stats:
  Direct: 45 msgs (95.6% success, 127ms avg)
  Relayed: 12 msgs (91.7% success, 342ms avg)
  GossipSub: 156 msgs (100.0% success, 89ms avg)
```

### AutoNAT Status

```
🔍 AutoNAT Reachability: public
🌐 Node is publicly accessible - relay server is active
```

Or:

```
🔍 AutoNAT Reachability: private
🔒 Node is behind NAT - using relay client mode only
```

### Connection Types

Check if connections are direct or relayed:

```typescript
const connections = node.getConnections(peerId);
connections.forEach(conn => {
  const isRelayed = conn.remoteAddr.toString().includes('/p2p-circuit/');
  console.log(`${peerId}: ${isRelayed ? 'Relayed' : 'Direct'}`);
});
```

## Performance Expectations

### Latency

| Method | Typical Range |
|--------|---------------|
| Direct | 50-200ms |
| Relayed | 150-500ms |
| GossipSub | 100-1000ms |

### Bandwidth

| Phase | Bandwidth Savings |
|-------|-------------------|
| Quote Discovery | 0% (still gossipsub) |
| Post-Selection | ~80% (no broadcast overhead) |
| Large Payloads | Most significant benefit |

### Relay Server Requirements

| Resource | Requirement |
|----------|-------------|
| CPU | Minimal (I/O bound) |
| Memory | 100-500MB (varies with load) |
| Bandwidth | Depends on relayed traffic |
| Connections | Scales with `maxRelayedConnections` |

## Troubleshooting

### Direct Messages Not Working

1. **Check if enabled**:
   ```typescript
   // In environment.ts
   directMessaging: { enabled: true }
   ```

2. **Check AutoNAT status**:
   Look for AutoNAT reachability logs

3. **Verify peer connection**:
   ```typescript
   const connections = node.getConnections(targetPeerId);
   console.log(`Connected: ${connections.length > 0}`);
   ```

### High Fallback Rate

If seeing frequent fallback to gossipsub:

1. **Network connectivity issues**: Check firewalls, port forwarding
2. **Peer offline**: Target peer may be disconnected
3. **Relay overload**: Bootstrap nodes may be at capacity

### Relay Server Not Working

1. **Check port accessibility**:
   ```bash
   # Test from external machine
   telnet your-server.com 4242
   ```

2. **Check AutoNAT detection**:
   Should show "public" reachability

3. **Review logs**:
   Look for relay-related errors or warnings

## Migration from Gossipsub-Only

### Step 1: Update Code

Pull latest code with direct messaging support:
```bash
git pull origin main
npm install
```

### Step 2: Update Environment Config

Add relay and directMessaging config to your `environment.ts` (or copy from `example.environment.ts`).

### Step 3: Test

```bash
npm run serve
```

Watch logs for:
- ✅ Direct messaging initialized
- 🔍 AutoNAT Reachability status
- 📊 Messaging stats

### Step 4: Verify

Send test messages and verify they use direct streams:
- Look for "✅ Direct message sent" logs
- Check messaging stats for direct/relayed counts

## Advanced Configuration

### Disable Direct Messaging

To disable and use gossipsub only:

```typescript
directMessaging: {
  enabled: false,
  // ... other settings
}
```

### Disable Relay Server

To prevent acting as relay (even if publicly accessible):

```typescript
relay: {
  enableRelayServer: false,
  autoEnableRelay: false,
  // ... other settings
}
```

### Custom Protocol

To use a custom protocol identifier:

```typescript
directMessaging: {
  protocol: '/myapp/direct/1.0.0',
  // ... other settings
}
```

## Security Considerations

### Message Authentication

- All messages (both gossipsub and direct) are signed with Algorand wallet keys
- Signatures verified before processing
- Invalid signatures are rejected

### Relay Trust

- Circuit relays **cannot read** message content (encrypted streams)
- Relays **can see** source/destination peer IDs
- Consider using trusted relay nodes for sensitive deployments

### DoS Prevention

- Rate limiting on direct message streams
- Relay resource limits enforced
- Abuse monitoring recommended

## FAQ

**Q: Do I need to open ports?**  
A: No, relay client mode works without open ports. However, opening ports enables relay server mode and better performance.

**Q: Will this work with old nodes?**  
A: Yes! Old nodes continue using gossipsub. New nodes support both methods.

**Q: What if direct messaging fails?**  
A: Automatic fallback to gossipsub ensures reliability (if `fallbackToGossipsub: true`).

**Q: How much faster is direct messaging?**  
A: Typically 50-80% faster for post-selection messages (depending on network topology).

**Q: Can I run a relay-only node?**  
A: Yes, configure as relay server with models disabled. Great for supporting the network!

**Q: Does this change the message format?**  
A: No, message formats are unchanged. Only the delivery method differs.

---

## Resources

- **Architecture Document**: See `plans/direct-messaging-relay-architecture.md`
- **Implementation Guide**: See `plans/implementation-guide.md`  
- **Unified Handler Pattern**: See `plans/unified-message-handler.md`
- **LibP2P Docs**: https://docs.libp2p.io/

---

**Need help?** Open an issue on GitHub or reach out in the community Discord.
