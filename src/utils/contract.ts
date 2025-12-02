import { ABIContractParams } from 'algosdk';

//ABI Specs
const DIIISCO_ABI_SPEC: ABIContractParams = {
  name: 'Diiisco',
  methods: [
    {
      name: 'createQuote',
      args: [
        { type: 'byte[]', name: 'quoteId' },
        { type: 'address', name: 'customer' },
        { type: 'uint64', name: 'usdcAmount' },
      ],
      returns: { type: 'void' },
    },
    {
      name: 'getQuote',
      args: [{ type: 'byte[]', name: 'quoteId' }],
      returns: {
        type: '(byte[],byte[],byte[],uint64,uint64,uint64,uint64)',
      },
    },
    {
      name: 'fundQuote',
      args: [{ type: 'byte[]', name: 'quoteId' }],
      returns: { type: 'void' },
    },
    {
      name: 'verifyQuoteFunded',
      args: [{ type: 'byte[]', name: 'quoteId' }],
      returns: {
        type: '(uint64,uint64,uint64)',
      },
    },
    {
      name: 'completeQuote',
      args: [
        { type: 'byte[]', name: 'quoteId' },
        { type: 'uint64', name: 'minDscoOut' },
      ],
      returns: { type: 'void' },
    },
    {
      name: 'refundQuote',
      args: [{ type: 'byte[]', name: 'quoteId' }],
      returns: { type: 'void' },
    },
  ],
};

// Prepare Smart Contract Object
// TESTNET INFO PROVDIED FOR PROD. REPALDE WHEN LIVE. 
const DIIISCO_CONTRACT: DiiiscoSmartContractConfig = { 
  abiSpec: DIIISCO_ABI_SPEC,
  app: 123456789, // Once the pool is live, we will replace this with appID of the deployed contract
  usdc: 31566704,
  asset: 3303055052,
  tinymanPoolAddress: "POOL_ADDR_HERE",
  tinymanApp: 1002541853, // Once the pool is live, we will replace this with appID of the Tinyman pool
  defaultMinDscoOut: 1,
};

// Prepare Smart Contract Object
const DIIISCO_CONTRACT_TESTNET: DiiiscoSmartContractConfig = { 
  abiSpec: DIIISCO_ABI_SPEC,
  app: 123456789, // Once the pool is live, we will replace this with appID of the deployed contract
  usdc: 31566704,
  asset: 3303055052,
  tinymanPoolAddress: "POOL_ADDR_HERE",
  tinymanApp: 1002541853, // Once the pool is live, we will replace this with appID of the Tinyman pool
  defaultMinDscoOut: 1,
};

export interface DiiiscoSmartContractConfig {
  abiSpec: ABIContractParams;
  app: number;
  usdc: number;
  asset: number;
  tinymanPoolAddress: string;
  tinymanApp: number;
  defaultMinDscoOut?: number; // Use number for bigint representation
}
  

// Export the contract object
export const diiiscoContract = process.env.NODE_ENV === 'production' ? DIIISCO_CONTRACT : DIIISCO_CONTRACT_TESTNET;

export default diiiscoContract;