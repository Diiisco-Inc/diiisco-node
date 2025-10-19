const environment: any = {
  models: {
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
    bearerAuthentication: true,
    keys: [
      "sk-testkey1",
      "sk-testkey2"
    ],
    port: 8181
  },
  quoteEngine: {
    waitTime: 1000
  }
}

export default environment; 