import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { identify, identifyPush } from '@libp2p/identify';
import { mdns } from '@libp2p/mdns';
import { mplex } from '@libp2p/mplex';
import { gossipsub } from '@libp2p/gossipsub';
import { logger } from '../utils/logger';
import { PeerIdManager } from './peerIdManager';

export const createLibp2pNode = async () => {
  const peer = await PeerIdManager.loadOrCreate('diiisco-peer-id.protobuf');

  const node = await createLibp2p({
    privateKey: peer.privateKey,
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
  });

  
  if (node.peerId.toString() !== peer.peerId.toString()) {
    throw new Error('libp2p did not use the supplied peerId');
  }
  
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