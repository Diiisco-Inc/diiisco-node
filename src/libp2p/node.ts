import PeerId, * as peerId from 'peer-id';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { identify } from '@libp2p/identify';
import { identifyPush } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { mplex } from '@libp2p/mplex';
import { gossipsub } from '@libp2p/gossipsub';
import { logger } from '../utils/logger';
import environment from '../environment/environment';

export const createLibp2pNode = async () => {
  const loadedPeerId = environment.peerId;
  if (!loadedPeerId) {
    logger.error("❌ PeerID not found in environment.ts. Please generate one using 'npm run get-peer-id' and add it to environment.ts.");
    throw new Error("PeerID not found.");
  }
  const peer = await peerId.createFromJSON(loadedPeerId);
  logger.info("✅ Loaded PeerID from environment.ts:", loadedPeerId.id);

  const node = await createLibp2p({
    peerId: peer,
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/4321']
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    peerDiscovery: [mdns()],
    streamMuxers: [mplex()],
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: true
      })
    }
  } as any); // Temporary workaround for peerId type issue

  await node.start()
  logger.info('✅ Node started with id:', node.peerId.toString());

  // Show multiaddresses
  logger.info('👂 Listening on:');
  node.getMultiaddrs().forEach(addr => logger.info(`   ${addr.toString()}`));
  return node;
};

export async function waitForMesh(node: any, topic: string, { min = 1, timeoutMs = 10000 } = {}) {
  const start = Date.now()
  for (;;) {
    const subs = node.services.pubsub.getSubscribers(topic)
    if (subs.length >= min) return subs
    if (Date.now() - start > timeoutMs) {
      logger.error(`Timeout waiting for peers in topic "${topic}"`);
      throw new Error(`No peers in topic "${topic}"`);
    }
    await new Promise(r => setTimeout(r, 300))
  }
}