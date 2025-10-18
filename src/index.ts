// Imports
import hasFlag from "has-flag";
import { getArgValue } from "./utils/argv";
import PeerId, * as peerId from 'peer-id';
import environment from "./environment/environment";
import path from "path";
import fs from "fs";

import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { multiaddr } from '@multiformats/multiaddr';
import { gossipsub } from '@libp2p/gossipsub';

// Types
export interface NodeOptions {
  apiAccess: boolean;
  peerId: PeerId | undefined;
  serveModels: boolean;
}

// Get the ID for the Node
const loadPeerId = (): peerId.JSONPeerId | undefined => {
  try {
    const peerIdData = fs.readFileSync('environment/peerId.json', 'utf-8');
    return JSON.parse(peerIdData) as peerId.JSONPeerId;
  } catch (error) {
    return undefined;
  }
};

const getPeerId = async (): Promise<PeerId> => {
  const loadedPeerId: peerId.JSONPeerId | undefined = loadPeerId();
  if (loadedPeerId) {
    console.log("✅ Loaded PeerID from environment/peerId.json:", loadedPeerId.id);
    return peerId.createFromJSON(loadedPeerId);
  } else {
    const newPeerId = await peerId.create({ bits: 1024, keyType: 'RSA' });
    const newPeerIdJSON = {
      id: newPeerId.toJSON().id,
      privKey: newPeerId.toJSON().privKey,
      pubKey: newPeerId.toJSON().pubKey
    };
    const peerIDJSON = JSON.stringify(newPeerIdJSON, null, 2);
    fs.writeFileSync(new URL('./environment/peerId.json', import.meta.url), peerIDJSON);
    
    console.log("👋 New PeerID Created and saved to environment/peerId.json");
    console.log("✅ Created PeerID:", newPeerIdJSON.id);

    return newPeerId;
  }
};

const createNode = async (peerId: PeerId) => {
  const node = await createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/4321']
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    services: {
      pubsub: gossipsub()
    }
  });

  await node.start()
  console.log('✅ Node started with id:', node.peerId.toString())

  // Show multiaddresses
  console.log('Listening on:')
  node.getMultiaddrs().forEach(addr => console.log(addr.toString()))
};

//Define the Main Function
const main = async () => {
  // Get Settings Shared to Node
  const options: NodeOptions = {
    apiAccess: hasFlag("api-access"),
    peerId: undefined,
    serveModels: hasFlag("share-models"),
  };

  // Get or Create Peer ID
  options.peerId = await getPeerId();

  // Create the Node
  if (options.peerId) {
    const node = await createNode(options.peerId);

    if (options.apiAccess) {
      console.log("🔜 Serving an OpenAI Compatible Endpoint");
    }

    if (options.serveModels) {
      console.log("🔜 Serving Models to the Diiisco Network");

    }
  } else {
    console.error("❌ Failed to obtain or create a Peer ID.");
  }
};

// Start the Server
main();