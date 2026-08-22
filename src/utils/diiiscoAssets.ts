import environment from '../environment/runtime';

/**
 * On-chain asset identifiers used by DIIISCO, selected by `algorand.network`.
 * (The escrow smart contract and its ABI/registration were retired with escrow;
 * only the ASAs remain — USDC for x402 settlement, DSCO for stake-weighted
 * quote selection and node identity.)
 */
export interface DiiiscoAssets {
  usdc: number;   // USDC ASA
  asset: number;  // DSCO ASA
}

const MAINNET: DiiiscoAssets = {
  usdc: 31566704,
  asset: 3303055052,
};

const TESTNET: DiiiscoAssets = {
  usdc: 10458941,
  asset: 748970589,
};

export const diiiscoAssets: DiiiscoAssets =
  environment.algorand?.network === 'testnet' ? TESTNET : MAINNET;

export default diiiscoAssets;
