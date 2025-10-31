import { Environment } from "./environment.types"; // Import the new interface

const environment: Environment = {
  peerIdStorage: {
    path: "~/Desktop/"
  },
  models: {
    enabled: true,
    baseURL: "http://localhost",
    port: 11434,
    apiKey: "YOUR_LOCAL_LLM_API_KEY_HERE_OFTEN_NOT_NEEDED",
    chargePer1KTokens: {
      default: 0.000001,
      "gpt-oss:20b": 0.000002,
    }
  },
  algorand: {
    addr: "YOUR_ALGORAND_ADDRESS_HERE",
    mnemonic: "YOUR_ALGORAND_MNEMONIC_HERE",
    client: {
      address: "https://mainnet-api.algonode.cloud/",
      port: 443,
      token: ""
    },
    paymentAssetId: 31566704
  },
  api: {
    enabled: true,
    bearerAuthentication: true,
    keys: [
      "sk-testkey1",
      "sk-testkey2"
    ],
    port: 8080
  },
  quoteEngine: {
    waitTime: 1000
  },
  libp2pBootstrapServers: [
    // To connect to nyc.diiisco.com, you need its full multiaddr, which includes its Peer ID.
    // You would obtain this Peer ID from the logs of the nyc.diiisco.com server when it starts.
    // Example: "/dns4/nyc.diiisco.com/tcp/8181/p2p/Qm...NYC_PEER_ID"
    // For now, using a placeholder. Replace "Qm...NYC_PEER_ID" with the actual Peer ID.
    "/dns4/nyc.diiisco.com/tcp/4242/p2p/Qm...NYC_PEER_ID_PLACEHOLDER"
  ],
  node: {
    url: "http://localhost",
    port: 4242
  }
}

export default environment;