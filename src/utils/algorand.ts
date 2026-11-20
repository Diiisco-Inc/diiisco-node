import environment from '../environment/runtime';
import algosdk from 'algosdk';
import { logger } from './logger';
import { Environment } from '../environment/environment.types';
import { NfdClient } from '@txnlab/nfd-sdk';
import { PubSubMessage } from '../types/messages';
import { canonicalize } from 'json-canonicalize';
import { getLocalMultiaddrs } from '../libp2p/localAddresses';
import { diiiscoAssets } from './diiiscoAssets';
import { ExpiringMap } from './expiringMap';

const SUGGESTED_PARAMS_TTL_MS = 4500;
const ASSET_LOOKUP_TTL_MS = 60_000;
const MAX_CONCURRENT_LOOKUPS = 8;
const MAX_CACHED_LOOKUPS = 2000;

export default class algorand {
  account: algosdk.Account;
  nfdAddr: string | null;
  nfdVerified: boolean = false;
  private env: Environment;
  private algod: algosdk.Algodv2;
  private assetLookups = new ExpiringMap<string, { optedIn: boolean; balance: bigint }>(30_000, MAX_CACHED_LOOKUPS);
  private assetLookupsInFlight = new Map<string, Promise<{ optedIn: boolean; balance: bigint }>>();
  private suggestedParamsCache: { params: algosdk.SuggestedParams; fetchedAt: number } | null = null;

  constructor() {
    this.env = environment;

    if (this.env.local?.enabled) {
      // Generate an ephemeral keypair used only for P2P message signing — no blockchain interaction.
      this.account = algosdk.generateAccount();
      this.nfdAddr = null;
      // algod client is not used in local mode; assign a placeholder to satisfy TS.
      this.algod = null as unknown as algosdk.Algodv2;
      return;
    }

    this.nfdAddr = this.env.algorand!.nfd || null;
    // The secret key is derived once; the mnemonic is not kept on this object.
    this.account = algosdk.mnemonicToSecretKey(this.env.algorand!.mnemonic);

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
    const signedBytes = algosdk.signBytes(bytes, this.account.sk);
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

  /**
   * Opt-in and balance of `address` for an asset. `cache: true` is for lookups a
   * stranger can provoke (a quote request names any wallet it likes): the answer
   * is reused for a minute, concurrent identical lookups share one algod call,
   * and no more than `MAX_CONCURRENT_LOOKUPS` run at once, so a flood cannot
   * turn this node into an algod-rate-limit exhauster. Errors are never cached.
   */
  async checkIfOptedInToAsset(address: string, assetId: number, options: { cache?: boolean } = {}): Promise<{ optedIn: boolean; balance: bigint }> {
    if (!options.cache) return this.lookupAsset(address, assetId);

    const key = `${address}:${assetId}`;
    const hit = this.assetLookups.get(key);
    if (hit) return hit;
    const pending = this.assetLookupsInFlight.get(key);
    if (pending) return pending;
    if (this.assetLookupsInFlight.size >= MAX_CONCURRENT_LOOKUPS) {
      throw new Error('too many concurrent account lookups');
    }

    const lookup = this.lookupAsset(address, assetId)
      .then((result) => {
        this.assetLookups.set(key, result, ASSET_LOOKUP_TTL_MS);
        return result;
      })
      .finally(() => this.assetLookupsInFlight.delete(key));
    this.assetLookupsInFlight.set(key, lookup);
    return lookup;
  }

  private async lookupAsset(address: string, assetId: number): Promise<{ optedIn: boolean; balance: bigint }> {
    try {
      // Fetch full account info
      const accountInfo = await this.algod.accountInformation(address).do();

      // Look for this ASA in their assets list
      const asset = accountInfo.assets?.find((a) => a.assetId === BigInt(assetId));

      if (!asset) {
        // Not opted-in
        return { optedIn: false, balance: 0n };
      }

      // Opted in; amount is in base units (respect asset decimals)
      return { optedIn: true, balance: BigInt(asset.amount) };
    } catch (err: any) { // TODO: Refine error type
      if (err.response?.body?.message?.includes("account does not exist")) {
        // The address has never been funded
        return { optedIn: false, balance: 0n };
      }
      console.error("Error checking if opted in:", err);
      throw err;
    }
  }

  async optInToAsset(address: string, assetId: number) {
    const sk = this.account.sk;

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
  const nfdData = await nfd.resolve(addr, { view: 'full'}).catch(() => null);
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
  const nfdData = await nfd.resolve(nfdAddr, { view: 'full'}).catch(() => null);
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