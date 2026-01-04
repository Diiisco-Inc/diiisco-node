import { ABIContractParams } from 'algosdk';

export interface VerifyQuoteFundedResult {
  funded: bigint;
  status: bigint;
  usdcAmount: bigint;
}

export interface QuoteDetails {
  quoteId: Uint8Array;
  provider: Uint8Array;
  customer: Uint8Array;
  usdcAmount: bigint;
  dscoAmount: bigint;
  status: bigint;
  lastUpdatedAt: bigint;
}

export interface DiiiscoSmartContractConfig {
  abiSpec: ABIContractParams;
  app: number;
  usdc: number;
  asset: number;
  tinymanPoolAddress: string;
  tinymanApp: number;
  defaultMinDscoOut?: number; // Use number for bigint representation
  rewardAsset?: number;
  rewardWallets?: string[];
}