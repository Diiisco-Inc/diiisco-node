import { sha256 } from 'js-sha256';
import environment from '../environment/environment';
import algosdk from 'algosdk';
import { logger } from './logger';
import { Environment } from '../environment/environment.types';
import { NfdClient } from '@txnlab/nfd-sdk';
import { verify } from 'crypto';
import { PubSubMessage } from '../types/messages';
import { canonicalize } from 'json-canonicalize';
import { diiiscoContract } from './contract';
import { QuoteDetails, VerifyQuoteFundedResult } from '../types/algorand';
import { ApplicationLocalState } from 'algosdk/dist/types/client/v2/algod/models/types';

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

const encoder = new TextEncoder();

function toBytes(s: string): Uint8Array {
  return encoder.encode(s);
}

function makeSigner(acct: algosdk.Account): algosdk.TransactionSigner {
  return algosdk.makeBasicAccountTransactionSigner(acct);
}

export default class algorand {
  mnemonic: string;
  account: algosdk.Account;
  nfdAddr: string | null;
  private env: Environment;
  private algod: algosdk.Algodv2;
  private contract: algosdk.ABIContract;
  private signer: algosdk.TransactionSigner;

  constructor() {
    this.env = environment;
    this.mnemonic = this.env.algorand.mnemonic;
    this.nfdAddr = this.env.algorand.nfd || null;
    this.account = algosdk.mnemonicToSecretKey(this.mnemonic);
    this.signer = makeSigner(this.account);

    this.algod = new algosdk.Algodv2(this.env.algorand.client.token, this.env.algorand.client.address, this.env.algorand.client.port);
    this.contract = new algosdk.ABIContract(diiiscoContract.abiSpec as algosdk.ABIContractParams);
  }

  async initialize(nodeId: string) {
    // validate that address is valid
    if (!algosdk.isValidAddress(this.account.addr.toString())) {
      throw new Error("❌ Invalid Algorand address provided in environment.");
    }

    // Validate address and mnemonic
    if (!this.mnemonicMatchesAddress(this.mnemonic, this.account.addr.toString())) {
      throw new Error("❌ Algorand mnemonic does not match the provided address.");
    }

    // Check the Address is opted in to the Diiisco ASA (Asset ID)
    try {
      const { optedIn } = await this.checkIfOptedInToAsset(this.account.addr.toString(), diiiscoContract.asset);
      if (!optedIn) {
        await this.optInToAsset(this.account.addr.toString(), diiiscoContract.asset);
        logger.info("✅ Opted in to Diiisco ASA");
      }
    } catch (err) {
      logger.error("❌ Failed to opt-in to Diiisco ASA:", err);
    }

    // Check the Address is Opted into USDC ASA (Asset ID)
    try {
      const { optedIn } = await this.checkIfOptedInToAsset(this.account.addr.toString(), diiiscoContract.usdc);
      if (!optedIn) {
        await this.optInToAsset(this.account.addr.toString(), diiiscoContract.usdc);
        logger.info("✅ Opted in to USDC ASA");
      }
    } catch (err) {
      logger.error("❌ Failed to opt-in to USDC ASA:", err);
    }

    // Check if the Address is registered in the Diiisco Contract
    try {
      const registered = await this.checkIfRegistered(this.account.addr.toString(), diiiscoContract.app);
      if (!registered) {
        await this.registerAddressForContract();
        logger.info("✅ Registered address in Diiisco Contract");
      }
    } catch (err) {
      logger.error("❌ Failed to register address in Diiisco Contract:", err);
    }

    //Verify the NFD if Provided
    if (this.nfdAddr) {
      verifyNFD(nodeId, this.account.addr.toString(), this.nfdAddr).then((isValid) => {
        if (isValid) {
          logger.info(`✅  NFD ${this.nfdAddr} successfully verified for node ID and wallet address.`);
        } else {
          logger.warn(`⚠️  NFD ${this.nfdAddr} verification failed for node ID and wallet address. Peers are less likely to trust this node.`);
        }
      }).catch((err) => {
        logger.error(`❌ Error verifying NFD ${this.nfdAddr}:`, err);
      });
    }
  }

  mnemonicMatchesAddress(mnemonic: string, address: string) {
    try {
      const { addr } = algosdk.mnemonicToSecretKey(mnemonic.trim());
      return algosdk.encodeAddress(algosdk.decodeAddress(addr.toString()).publicKey) === address;
    } catch {
      return false; // bad mnemonic or bad address format
    }
  }

  async signObject(obj: any){
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
    const algod = new algosdk.Algodv2(
      this.env.algorand.client.token,
      this.env.algorand.client.address,
      this.env.algorand.client.port
    );
    
    try {
      // Fetch full account info
      const accountInfo = await algod.accountInformation(address).do();

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
    const algod = new algosdk.Algodv2(
      this.env.algorand.client.token,
      this.env.algorand.client.address,
      this.env.algorand.client.port
    );
    const sk = algosdk.mnemonicToSecretKey(this.mnemonic).sk;

    const sp = await algod.getTransactionParams().do()
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      receiver: address,
      sender: this.account.addr,
      amount: BigInt(0),
      assetIndex: assetId,
      note: new TextEncoder().encode("Opt-in to Diiisco ASA."),
      suggestedParams: sp
    });

    const signed = txn.signTxn(sk)
    const txId = await algod.sendRawTransaction(signed).do();
    logger.info(`⏳ Waiting for confirmation of opt-in transaction ID: ${txId.txid}...`);
    const transactionCompletion = await algosdk.waitForConfirmation(algod, txId.txid, 5);
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
  private getAppAddress(): algosdk.Address {
    if (!diiiscoContract) throw new Error("Smart contract configuration is missing.");
    return algosdk.getApplicationAddress(diiiscoContract.app);
  }

  private async getSuggestedParams(): Promise<algosdk.SuggestedParams> {
    const sp = await this.algod.getTransactionParams().do();
    sp.flatFee = false;
    return sp;
  }

  async checkIfRegistered(address: string, app: number): Promise<boolean> {
    if (!diiiscoContract) throw new Error("Smart contract configuration is missing.");
    try {
      const accountInfo = await this.algod.accountInformation(address).do();
      const appOptInState: ApplicationLocalState | undefined = accountInfo.appsLocalState?.find(
        (localState: any) => localState.id === BigInt(app)
      );
      return appOptInState !== undefined ;
    } catch(error) {
      return false;
    }
  }

  async registerAddressForContract(): Promise<number> {
    if (!diiiscoContract) throw new Error("Smart contract configuration is missing.");
    const sc = diiiscoContract;

    const sp = await this.getSuggestedParams();
    const atc = new algosdk.AtomicTransactionComposer();
    const method = this.contract.getMethodByName('optInToApplication');

    atc.addMethodCall({
      appID: sc.app,
      method,
      methodArgs: [],
      sender: this.account.addr,
      suggestedParams: sp,
      signer: this.signer,
      boxes: [],
      onComplete: algosdk.OnApplicationComplete.OptInOC,
    });

    const res = await atc.execute(this.algod, 4);
    return Number(res.confirmedRound);
  }

  async createQuote(options: {
    quoteId: string;
    customerAddress: string;
    usdcAmount: bigint;
  }): Promise<number> {
    if (!diiiscoContract) throw new Error("Smart contract configuration is missing.");
    const sc = diiiscoContract;

    const quoteId = options.quoteId;
    if (!quoteId) throw new Error('quoteId is required');

    const customerAddress = options.customerAddress;
    const usdcAmount = options.usdcAmount;
    if (usdcAmount === undefined) throw new Error('usdcAmount is required');

    const sp = await this.getSuggestedParams();
    const atc = new algosdk.AtomicTransactionComposer();
    const method = this.contract.getMethodByName('createQuote');

    const quoteIdBytes = toBytes(quoteId);
    const boxName = toBytes('quotes' + quoteId);

    atc.addMethodCall({
      appID: sc.app,
      method,
      methodArgs: [quoteIdBytes, customerAddress, usdcAmount],
      sender: this.account.addr,
      suggestedParams: sp,
      signer: this.signer,
      boxes: [
        {
          appIndex: sc.app,
          name: boxName,
        },
      ],
    });

    const res = await atc.execute(this.algod, 4);
    return Number(res.confirmedRound);
  }

  async fundQuote(options: {
    quoteId: string;
    usdcAmount: bigint;
  }): Promise<number> {
    if (!diiiscoContract) throw new Error("Smart contract configuration is missing.");
    const sc = diiiscoContract;

    const quoteId = options.quoteId;
    if (!quoteId) throw new Error('quoteId is required');

    const usdcAmount = options.usdcAmount;
    if (usdcAmount === undefined) throw new Error('usdcAmount is required');

    const sp = await this.getSuggestedParams();
    const atc = new algosdk.AtomicTransactionComposer();

    const appAddress = this.getAppAddress();
    const quoteIdBytes = toBytes(quoteId);
    const boxName = toBytes('quotes' + quoteId);

    const usdcTx = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: this.account.addr,
      receiver: appAddress,
      assetIndex: sc.usdc,
      amount: Number(usdcAmount),
      suggestedParams: sp,
    });

    atc.addTransaction({
      txn: usdcTx,
      signer: this.signer,
    });

    const method = this.contract.getMethodByName('fundQuote');

    atc.addMethodCall({
      appID: sc.app,
      method,
      methodArgs: [quoteIdBytes],
      sender: this.account.addr,
      suggestedParams: sp,
      signer: this.signer,
      boxes: [
        {
          appIndex: sc.app,
          name: boxName,
        },
      ],
    });

    const res = await atc.execute(this.algod, 4);
    return Number(res.confirmedRound);
  }

  async getQuote(quoteId: string): Promise<QuoteDetails> {
    if (!diiiscoContract) throw new Error("Smart contract configuration is missing.");
    const sc = diiiscoContract;

    const qid = quoteId;
    if (!qid) throw new Error('quoteId is required');

    const sp = await this.getSuggestedParams();
    const atc = new algosdk.AtomicTransactionComposer();
    const method = this.contract.getMethodByName('getQuote');

    const quoteIdBytes = toBytes(qid);
    const boxName = toBytes('quotes' + qid);

    atc.addMethodCall({
      appID: sc.app,
      method,
      methodArgs: [quoteIdBytes],
      sender: this.account.addr,
      suggestedParams: sp,
      signer: this.signer,
      boxes: [
        {
          appIndex: sc.app,
          name: boxName,
        },
      ],
    });

    const res = await atc.execute(this.algod, 4);
    const tup = res.methodResults[0].returnValue as [
      Uint8Array,
      Uint8Array,
      Uint8Array,
      bigint,
      bigint,
      bigint,
      bigint,
    ];

    const [qidBytes, provider, customer, usdcAmount, dscoAmount, status, lastUpdatedAt] = tup;

    return {
      quoteId: qidBytes,
      provider,
      customer,
      usdcAmount,
      dscoAmount,
      status,
      lastUpdatedAt,
    };
  }

  async verifyQuoteFunded(quoteId: string): Promise<VerifyQuoteFundedResult> {
    if (!diiiscoContract) throw new Error("Smart contract configuration is missing.");
    const sc = diiiscoContract;

    const qid = quoteId;
    if (!qid) throw new Error('quoteId is required');

    const sp = await this.getSuggestedParams();
    const atc = new algosdk.AtomicTransactionComposer();
    const method = this.contract.getMethodByName('verifyQuoteFunded');

    const quoteIdBytes = toBytes(qid);
    const boxName = toBytes('quotes' + qid);

    atc.addMethodCall({
      appID: sc.app,
      method,
      methodArgs: [quoteIdBytes],
      sender: this.account.addr,
      suggestedParams: sp,
      signer: this.signer,
      boxes: [
        {
          appIndex: sc.app,
          name: boxName,
        },
      ],
    });

    const res = await atc.execute(this.algod, 4);
    const value = res.methodResults[0].returnValue as [bigint, bigint, bigint];
    const [funded, status, usdcAmount] = value;

    return { funded, status, usdcAmount };
  }

  async completeQuote(options: {
    quoteId: string;
    minDscoOut?: bigint;
  }): Promise<number> {
    if (!diiiscoContract) throw new Error("Smart contract configuration is missing.");
    const sc = diiiscoContract;

    const quoteId = options.quoteId;
    if (!quoteId) throw new Error('quoteId is required');

    const minDscoOut = options.minDscoOut ?? 0;

    const sp = await this.getSuggestedParams();
    const atc = new algosdk.AtomicTransactionComposer();
    const method = this.contract.getMethodByName('completeQuote');

    const quoteIdBytes = toBytes(quoteId);
    const boxName = toBytes('quotes' + quoteId);

    const spFlat: algosdk.SuggestedParams = { ...sp, flatFee: true, fee: 5000 };

    atc.addMethodCall({
      appID: sc.app,
      method,
      methodArgs: [quoteIdBytes, minDscoOut],
      sender: this.account.addr,
      suggestedParams: spFlat,
      signer: this.signer,
      boxes: [
        {
          appIndex: sc.app,
          name: boxName,
        },
      ],
      appAccounts: [sc.tinymanPoolAddress],
      appForeignAssets: [sc.usdc, sc.asset],
      appForeignApps: [sc.tinymanApp],
    });

    const res = await atc.execute(this.algod, 4);
    return Number(res.confirmedRound);
  }

  async refundQuote(options: {
    quoteId: string 
  }): Promise<number> {
    if (!diiiscoContract) throw new Error("Smart contract configuration is missing.");
    const sc = diiiscoContract;

    const quoteId = options.quoteId;
    if (!quoteId) throw new Error('quoteId is required');

    const sp = await this.getSuggestedParams();
    const atc = new algosdk.AtomicTransactionComposer();
    const method = this.contract.getMethodByName('refundQuote');

    const quoteIdBytes = toBytes(quoteId);
    const boxName = toBytes('quotes' + quoteId);

    atc.addMethodCall({
      appID: sc.app,
      method,
      methodArgs: [quoteIdBytes],
      sender: this.account.addr,
      suggestedParams: sp,
      signer: this.signer,
      boxes: [
        {
          appIndex: sc.app,
          name: boxName,
        },
      ],
    });

    const res = await atc.execute(this.algod, 4);
    return Number(res.confirmedRound);
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