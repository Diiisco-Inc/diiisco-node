import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { identify, identifyPush } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { mdns } from '@libp2p/mdns';
import { mplex } from '@libp2p/mplex';
import { gossipsub } from '@libp2p/gossipsub';
import { kadDHT } from '@libp2p/kad-dht';
import { logger } from '../utils/logger';
import { PeerIdManager } from './peerIdManager';
import { bootstrap, BootstrapInit } from '@libp2p/bootstrap';
import environment from '../environment/environment';
import { NfdClient } from '@txnlab/nfd-sdk';

export const createLibp2pNode = async () => {
  // Load or Create a Peer ID
  const peer = await PeerIdManager.loadOrCreate('diiisco-peer-id.protobuf');

  // Prepare Peer Discovery Modules
  const peerDiscovery: any[] = [mdns()];
  
  if (environment.libp2pBootstrapServers && environment.libp2pBootstrapServers.length > 0) {
    //Process Bootstrap Servers
    const nfd = new NfdClient();
    const parsedBootstrapServers = (await Promise.all(environment.libp2pBootstrapServers.map(async (addr: string) => {
      addr = addr.trim();
      if (addr.endsWith('diiisco.algo')) {
        const nfdData = await nfd.resolve(addr, { view: 'full'});
        const diiiscohost: string | null = nfdData.properties?.userDefined?.diiiscohost ?? null;
        const libp2pAddressRegex = /^\/ip4\/[a-zA-Z0-9.-]+\/tcp\/\d+\/p2p\/[a-zA-Z0-9]+$/;
        if (diiiscohost && libp2pAddressRegex.test(diiiscohost)) {
          return diiiscohost;
        } else {
          logger.warn(`⚠️ Invalid libp2p address format in diiiscohost: ${diiiscohost}`);
          return null;
        }
      }
      return addr;
    }))).filter((addr: string | null) => addr !== null);

    peerDiscovery.push(bootstrap({
      list: parsedBootstrapServers,
    }));
  }

  // Create the Libp2p Node
  const node = await createLibp2p({
    privateKey: peer.privateKey,
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${environment.node?.port || 4242}`]
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    peerDiscovery,
    services: {
      identify: identify(),
      identifyPush: identifyPush(),
      ping: ping(),
      pubsub: gossipsub({
        allowPublishToZeroTopicPeers: true,
        emitSelf: true
      }),
      dht: kadDHT()
    }
  });

  // Check if Libp2p used the supplied Peer ID
  if (node.peerId.toString() !== peer.peerId.toString()) {
    throw new Error('libp2p did not use the supplied peerId');
  }
  
  // Start the Libp2p Node
  await node.start()
  logger.info('✅ Node started with id:', node.peerId.toString());

  // Show Connection Details
  logger.info('👂 Listening on:');
  node.getMultiaddrs().forEach(addr => logger.info(`   ${addr.toString()}`));
  if (environment.node && environment.node.url && !environment.node.url.includes('localhost')) {
    logger.info(`📬 Other nodes can Connect at: "/dns4/${environment.node.url}/tcp/${environment.node?.port || 4242}/p2p/${node.peerId.toString()}"`);
  }
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