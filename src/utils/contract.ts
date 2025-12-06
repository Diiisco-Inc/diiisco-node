import environment from '../environment/example.environment';
import { DiiiscoSmartContractConfig } from '../types/algorand';
import { ABIContractParams } from 'algosdk';

//ABI Specs
const DIIISCO_ABI_SPEC: ABIContractParams = {
  name: 'Diiisco',
  methods: [
    {
      name: 'optInToApplication',
      args: [],
      returns: { type: 'void' },
    },
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
  app: 749916870, // Once the pool is live, we will replace this with appID of the deployed contract
  usdc: 31566704,
  asset: 748970589,
  tinymanPoolAddress: "POOL_ADDR_HERE",
  tinymanApp: 1002541853, // Once the pool is live, we will replace this with appID of the Tinyman pool
  defaultMinDscoOut: 1,
};

// Prepare Smart Contract Object
const DIIISCO_CONTRACT_TESTNET: DiiiscoSmartContractConfig = { 
  abiSpec: DIIISCO_ABI_SPEC,
  app: 751491639, // Once the pool is live, we will replace this with appID of the deployed contract
  usdc: 10458941,
  asset: 748970589,
  tinymanPoolAddress: "L2NEJ2YDVT3XYAHUMAWBV744E4AB6ZEKVLPW3YB3JY44Q6UUUGGD5XU5IA",
  tinymanApp: 148607000, // Once the pool is live, we will replace this with appID of the Tinyman pool
  defaultMinDscoOut: 1,
};  

// Export the contract object
export const diiiscoContract = environment.algorand.network === 'mainnet' ? DIIISCO_CONTRACT : DIIISCO_CONTRACT_TESTNET;

export default diiiscoContract;