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