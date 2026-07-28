import { sha256 } from 'js-sha256';
import environment from '../environment/environment';
import algosdk from 'algosdk';
import { logger } from './logger';
import { Environment } from '../environment/environment.types';
import { NfdClient } from '@txnlab/nfd-sdk';
import { verify } from 'crypto';
import { PubSubMessage } from '../types/messages';
import { canonicalize } from 'json-canonicalize';
import { getLocalMultiaddrs } from '../libp2p/localAddresses';
import { diiiscoAssets } from './diiiscoAssets';

/**
 * Recursively sorts object keys and stringifies to ensure a canonical representation.
 * This is crucial for consistent signing and verification of objects.
 * @param obj The object to stringify.
 * @returns A canonical JSON string representation of the object.
 */
function canonicalStringify(obj: any): string {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return '[' + obj.map(item => canonicalStringify(item)).join(',') + ']';
  }

  const sortedKeys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of sortedKeys) {
    parts.push(JSON.stringify(key) + ':' + canonicalStringify(obj[key]));
  }
  return '{' + parts.join(',') + '}';
}

function makeSigner(acct: algosdk.Account): algosdk.TransactionSigner {
  return algosdk.makeBasicAccountTransactionSigner(acct);
}

const SUGGESTED_PARAMS_TTL_MS = 4500;

export default class algorand {
  mnemonic: string;
  account: algosdk.Account;
  nfdAddr: string | null;
  nfdVerified: boolean = false;
  private env: Environment;
  private algod: algosdk.Algodv2;
  private signer: algosdk.TransactionSigner;
  private suggestedParamsCache: { params: algosdk.SuggestedParams; fetchedAt: number } | null = null;

  constructor() {
    this.env = environment;

    if (this.env.local?.enabled) {
      // Generate an ephemeral keypair used only for P2P message signing — no blockchain interaction.
      this.account = algosdk.generateAccount();
      this.mnemonic = algosdk.secretKeyToMnemonic(this.account.sk);
      this.nfdAddr = null;
      this.signer = makeSigner(this.account);
      // algod client is not used in local mode; assign a placeholder to satisfy TS.
      this.algod = null as unknown as algosdk.Algodv2;
      return;
    }

    this.mnemonic = this.env.algorand!.mnemonic;
    this.nfdAddr = this.env.algorand!.nfd || null;
    this.account = algosdk.mnemonicToSecretKey(this.mnemonic);
    this.signer = makeSigner(this.account);

    this.algod = new algosdk.Algodv2(this.env.algorand!.client.token, this.env.algorand!.client.address, this.env.algorand!.client.port);
  }

  async initialize(nodeId: string) {
    if (this.env.local?.enabled) {
      logger.info("🏠 Local mode enabled — Algorand payments are disabled. Using ephemeral identity for message signing.");
      return;
    }

    // Sanity-check the derived address (guards against a malformed mnemonic).
    if (!algosdk.isValidAddress(this.account.addr.toString())) {
      throw new Error("❌ Invalid Algorand mnemonic provided in environment.");
    }

    // Check the Address is opted in to the Diiisco ASA (Asset ID)
    try {
      const { optedIn } = await this.checkIfOptedInToAsset(this.account.addr.toString(), diiiscoAssets.asset);
      if (!optedIn) {
        await this.optInToAsset(this.account.addr.toString(), diiiscoAssets.asset);
        logger.info("✅ Opted in to Diiisco ASA");
      }
    } catch (err) {
      logger.error("❌ Failed to opt-in to Diiisco ASA:", err);
    }

    // Check the Address is Opted into USDC ASA (Asset ID)
    try {
      const { optedIn } = await this.checkIfOptedInToAsset(this.account.addr.toString(), diiiscoAssets.usdc);
      if (!optedIn) {
        await this.optInToAsset(this.account.addr.toString(), diiiscoAssets.usdc);
        logger.info("✅ Opted in to USDC ASA");
      }
    } catch (err) {
      logger.error("❌ Failed to opt-in to USDC ASA:", err);
    }

    //Verify the NFD if Provided
    if (this.nfdAddr) {
      verifyNFD(nodeId, this.account.addr.toString(), this.nfdAddr).then((isValid) => {
        if (isValid) {
          this.nfdVerified = true;
          logger.info(`✅  NFD ${this.nfdAddr} successfully verified for node ID and wallet address.`);
        } else {
          logger.warn(`⚠️  NFD ${this.nfdAddr} verification failed for node ID and wallet address. Peers are less likely to trust this node.`);
        }
      }).catch((err) => {
        logger.error(`❌ Error verifying NFD ${this.nfdAddr}:`, err);
      });
    }
  }

  async signObject(obj: any){
    // Stamp our current multiaddrs (incl. relay-circuit addresses) onto the
    // message so recipients can dial us over a relay without a DHT lookup. We
    // mutate the caller's object in place so the transmitted message matches
    // exactly what we sign here — otherwise verification would fail.
    const addrs = getLocalMultiaddrs();
    if (addrs.length > 0) {
      obj.multiaddrs = addrs;
    }

    // Remove signature field if it exists to avoid signing the signature itself
    if ('signature' in obj) {
      const { signature, ...objWithoutSignature } = obj;
      obj = objWithoutSignature;
    }

    // Sign the Payload
    const bytes = new TextEncoder().encode(canonicalize(obj));
    const signedBytes = algosdk.signBytes(bytes, algosdk.mnemonicToSecretKey(this.mnemonic).sk);
    const signatureB64 = Buffer.from(signedBytes).toString('base64');
    return signatureB64;
  }

  async verifySignature(obj: PubSubMessage){
    // Remove signature field if it exists to avoid verifying the signature itself
    let sig: string | undefined = "";
    if ('signature' in obj) {
      const { signature, ...objWithoutSignature } = obj;
      sig = signature;
      obj = objWithoutSignature;
    } else {
      return false
    }

    // Verify the Signature and Payload
    const bytes = new TextEncoder().encode(canonicalize(obj));
    const signatureBytes = Buffer.from(sig!, 'base64');
    const verified = algosdk.verifyBytes(bytes, signatureBytes, obj.fromWalletAddr);
    return verified;
  }

  async checkIfOptedInToAsset(address: string, assetId: number): Promise<{ optedIn: boolean; balance: BigInt }> {
    try {
      // Fetch full account info
      const accountInfo = await this.algod.accountInformation(address).do();

      // Look for this ASA in their assets list
      const asset = accountInfo.assets?.find((a) => a.assetId === BigInt(assetId));

      if (!asset) {
        // Not opted-in
        return { optedIn: false, balance: BigInt(0) };
      }

      // Opted in; amount is in base units (respect asset decimals)
      return { optedIn: true, balance: BigInt(asset.amount) };
    } catch (err: any) { // TODO: Refine error type
      if (err.response?.body?.message?.includes("account does not exist")) {
        // The address has never been funded
        return { optedIn: false, balance: BigInt(0) };
      }
      console.error("Error checking if opted in:", err);
      throw err;
    }
  }

  async optInToAsset(address: string, assetId: number) {
    const sk = algosdk.mnemonicToSecretKey(this.mnemonic).sk;

    const sp = await this.getSuggestedParams();
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      receiver: address,
      sender: this.account.addr,
      amount: BigInt(0),
      assetIndex: assetId,
      note: new TextEncoder().encode("Opt-in to Diiisco ASA."),
      suggestedParams: sp
    });

    const signed = txn.signTxn(sk)
    const txId = await this.algod.sendRawTransaction(signed).do();
    logger.info(`⏳ Waiting for confirmation of opt-in transaction ID: ${txId.txid}...`);
    const transactionCompletion = await algosdk.waitForConfirmation(this.algod, txId.txid, 5);
    this.suggestedParamsCache = null;
    logger.info(`✅ Opted in to asset ID ${assetId} for address ${address}. Transaction ID: ${txId.txid}`);
    return transactionCompletion;
  }

  /**
   * Converts a decimal amount to Algorand's microAlgos (or other asset's base units)
   * with proper handling for decimals and rounding.
   * @param amount The decimal amount as a number or string.
   * @param decimals The number of decimal places for the asset.
   * @returns The amount in base units as a BigInt.
   */
  parseUnits(amount: number | string, decimals: number): bigint {
    if (typeof amount === 'number') amount = String(amount); // avoid float ops where possible
    amount = amount.trim();
    if (!/^-?\d+(\.\d+)?$/.test(amount)) {
      throw new Error('Invalid decimal amount format');
    }

    const negative = amount.startsWith('-');
    if (negative) amount = amount.slice(1);

    const [intPartRaw, fracPartRaw = ''] = amount.split('.');
    let intPart = intPartRaw.replace(/^0+/, '') || '0';
    let fracPart = fracPartRaw.replace(/[^0-9]/g, ''); // keep only digits

    // If fractional digits <= decimals: pad right
    if (fracPart.length <= decimals) {
      const padded = fracPart + '0'.repeat(decimals - fracPart.length);
      const whole = BigInt(intPart) * 10n ** BigInt(decimals) + BigInt(padded || '0');
      return negative ? -whole : whole;
    }

    // If fractional digits > decimals: round half-up
    const keep = fracPart.slice(0, decimals);            // digits to keep
    const nextDigit = Number(fracPart[decimals]);       // digit after kept digits
    let fracBig = BigInt(keep || '0');

    if (nextDigit >= 5) {
      fracBig = fracBig + 1n;
      // handle carry if fracBig == 10^decimals
      const maxFrac = 10n ** BigInt(decimals);
      if (fracBig >= maxFrac) {
        fracBig = 0n;
        const whole = (BigInt(intPart) + 1n) * maxFrac + fracBig;
        return negative ? -whole : whole;
      }
    }

    const whole = BigInt(intPart) * 10n ** BigInt(decimals) + fracBig;
    return negative ? -whole : whole;
  }
  private async getSuggestedParams(): Promise<algosdk.SuggestedParams> {
    const now = Date.now();
    if (!this.suggestedParamsCache || now - this.suggestedParamsCache.fetchedAt > SUGGESTED_PARAMS_TTL_MS) {
      const sp = await this.algod.getTransactionParams().do();
      sp.flatFee = false;
      this.suggestedParamsCache = { params: sp, fetchedAt: now };
    }
    return { ...this.suggestedParamsCache.params };
  }

  isValidAddress(addr: string): boolean {
    return algosdk.isValidAddress(addr);
  }

  async getDiagnostics(): Promise<{
    localMode: boolean;
    address?: string;
    algodReachable: boolean;
    algoBalance?: string;
    dsco?: { optedIn: boolean; balance: string };
    usdc?: { optedIn: boolean; balance: string };
    error?: string;
  }> {
    if (this.env.local?.enabled) {
      return { localMode: true, algodReachable: false };
    }

    const address = this.account.addr.toString();
    const result: Awaited<ReturnType<algorand['getDiagnostics']>> = {
      localMode: false,
      address,
      algodReachable: false,
    };

    try {
      const accountInfo = await this.algod.accountInformation(address).do();
      result.algodReachable = true;
      result.algoBalance = (Number(accountInfo.amount) / 1_000_000).toFixed(6) + ' ALGO';

      const dsco = await this.checkIfOptedInToAsset(address, diiiscoAssets.asset);
      result.dsco = { optedIn: dsco.optedIn, balance: dsco.balance.toString() };

      const usdc = await this.checkIfOptedInToAsset(address, diiiscoAssets.usdc);
      result.usdc = { optedIn: usdc.optedIn, balance: (Number(usdc.balance) / 1_000_000).toFixed(6) + ' USDC' };
    } catch (err: any) {
      result.error = err.message ?? String(err);
    }

    return result;
  }
}

export async function nfdToNodeAddress(addr: string): Promise<string | null> {
  const nfd = new NfdClient();
  const nfdData = await nfd.resolve(addr, { view: 'full'}).catch((err) => null);
  const diiiscohost: string | null = nfdData?.properties?.userDefined?.diiiscohost ?? null;
  const libp2pAddressRegex = /^\/(dns4|ip4)\/[a-zA-Z0-9.-]+\/tcp\/\d+\/p2p\/[a-zA-Z0-9]+$/;
  if (diiiscohost && libp2pAddressRegex.test(diiiscohost)) {
    return diiiscohost;
  } else {
    logger.warn(`⚠️ Invalid libp2p address format in diiiscohost: ${diiiscohost}`);
    return null;
  }
}

export async function nfdToWalletAddress(nfdAddr: string): Promise<string | null> {
  const nfd = new NfdClient();
  const nfdData = await nfd.resolve(nfdAddr, { view: 'full'}).catch((err) => null);
  const walletAddr: string | null = nfdData?.owner ?? null;
  if (walletAddr && algosdk.isValidAddress(walletAddr)) {
    return walletAddr;
  } else {
    logger.warn(`⚠️ Invalid Algorand wallet address in NFD record: ${walletAddr}`);
    return null;
  }
}

export async function verifyNFD(nodeId: string, walletAddr: string, nfdAddr: string): Promise<boolean> {
  // Check the Official Record of the Node ID Associated with the NFD
  const checkNodePath: string | null = await nfdToNodeAddress(nfdAddr);
  if (!checkNodePath) return false;
  const checkNodeSegments: string[] = checkNodePath.split('/');
  const checkNodeId: string = checkNodeSegments[checkNodeSegments.length - 1];
  if (checkNodeId !== nodeId) return false;

  // Check the Official Record of the Wallet Address Associated with the NFD
  const checkWalletAddr: string | null = await nfdToWalletAddress(nfdAddr);
  if (!checkWalletAddr) return false;
  if (checkWalletAddr !== walletAddr) return false;

  return true;
}