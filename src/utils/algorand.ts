import { sha256 } from 'js-sha256';
import environment from '../environment/environment';
import algosdk from 'algosdk';
import { logger } from './logger';
import { Environment } from '../environment/environment.types';
import { NfdClient } from '@txnlab/nfd-sdk';
import { verify } from 'crypto';

export default class algorand {
  addr: string;
  mnemonic: string;
  nfdAddr: string | null;
  private env: Environment;

  constructor() {
    this.env = environment;
    this.addr = this.env.algorand.addr;
    this.mnemonic = this.env.algorand.mnemonic;
    this.nfdAddr = this.env.algorand.nfd || null;
  }

  async initialize(nodeId: string) {
    // validate that address is valid
    if (!algosdk.isValidAddress(this.addr)) {
      throw new Error("❌ Invalid Algorand address provided in environment.");
    }

    // Validate address and mnemonic
    if (!this.mnemonicMatchesAddress(this.mnemonic, this.addr)) {
      throw new Error("❌ Algorand mnemonic does not match the provided address.");
    }

    // Check the Address is opted in to the Diiisco ASA (Asset ID)
    try {
      const { optedIn } = await this.checkIfOptedIn(this.addr, this.env.algorand.paymentAssetId);
      if (!optedIn) {
        await this.optInToAsset(this.addr, this.env.algorand.paymentAssetId);
        logger.info("✅ Opted in to Diiisco ASA");
      }
    } catch (err) {
      logger.error("❌ Failed to opt-in to Diiisco ASA:", err);
    }

    //Verify the NFD if Provided
    if (this.nfdAddr) {
      verifyNFD(nodeId, this.addr, this.nfdAddr).then((isValid) => {
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
    return sha256(`${JSON.stringify(obj)}, ${this.mnemonic}`);
  }

  async verifySignature(obj: any, signature: string){
    const expectedSignature = await this.signObject(obj);
    return expectedSignature === signature;
  }

  async makePayment(toAddr: string, amount: number){
    const algod = new algosdk.Algodv2(
      this.env.algorand.client.token,
      this.env.algorand.client.address,
      this.env.algorand.client.port
    );
    const sk = algosdk.mnemonicToSecretKey(this.mnemonic).sk;

    const sp = await algod.getTransactionParams().do()
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      receiver: toAddr,
      sender: this.addr,
      amount: this.parseUnits(Math.max(amount, 0.000001), this.env.algorand.paymentAssetDecimals || 6), //DSCO has 6 Decimals
      assetIndex: this.env.algorand.paymentAssetId,
      note: new TextEncoder().encode("Payment for Diiisco model inference."),
      suggestedParams: sp
    });

    const signed = txn.signTxn(sk)
    const txId = await algod.sendRawTransaction(signed).do();
    logger.info(`⏳ Waiting for confirmation of transaction ID: ${txId.txid}...`);
    const transactionCompletion = await algosdk.waitForConfirmation(algod, txId.txid, 5);
    logger.info(`💰 Payment of ${amount} DSCO sent to ${toAddr}. Transaction ID: ${txId.txid}`);
    return transactionCompletion;
  }

  async checkIfOptedIn(address: string, assetId: number): Promise<{ optedIn: boolean; balance: BigInt }> {
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
      sender: this.addr,
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