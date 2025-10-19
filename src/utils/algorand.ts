import { sha256 } from 'js-sha256';
import environment from '../environment/environment';
import algosdk from 'algosdk';

export default class algorand {
  addr: string;
  mnemonic: string;

  constructor() {
    this.addr = environment.algorand.addr;
    this.mnemonic = environment.algorand.mnemonic;

    // validate that address is valid
    if (!algosdk.isValidAddress(this.addr)) {
      throw new Error("❌ Invalid Algorand address provided in environment.");
    }

    // Validate address and mnemonic
    if (!this.mnemonicMatchesAddress(this.mnemonic, this.addr)) {
      throw new Error("❌ Algorand mnemonic does not match the provided address.");
    }

    // Check the Address is opted in to the Diiisco ASA (Asset ID)
    this.checkIfOptedIn(this.addr, environment.algorand.paymentAssetId).then(({ optedIn, balance }) => {
      if (!optedIn) {
        // Opt-in to the ASA
        this.optInToAsset(this.addr, environment.algorand.paymentAssetId).then(() => {
          console.log("✅ Opted in to Diiisco ASA");
        }).catch((err) => {
          console.error("❌ Failed to opt-in to Diiisco ASA:", err);
        });
      }
    });
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
      environment.algorand.client.token,
      environment.algorand.client.address,
      environment.algorand.client.port
    );
    const sk = algosdk.mnemonicToSecretKey(this.mnemonic).sk;

    const sp = await algod.getTransactionParams().do()
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      receiver: toAddr,
      sender: this.addr,
      amount: BigInt(amount),
      assetIndex: 0,
      note: new TextEncoder().encode("Payment for Diiisco model inference."),
      suggestedParams: sp
    });

    const signed = txn.signTxn(sk)
    const txId = await algod.sendRawTransaction(signed).do();
    console.log(`⏳ Waiting for confirmation of transaction ID: ${txId.txid}...`);
    const transactionCompletion = await algosdk.waitForConfirmation(algod, txId.txid, 5);
    console.log(`💰 Payment of ${amount} DSCO sent to ${toAddr}. Transaction ID: ${txId.txid}`);
    return transactionCompletion;
  }

  async checkIfOptedIn(address: string, assetId: number): Promise<{ optedIn: boolean; balance: BigInt }> {
    const algod = new algosdk.Algodv2(
      environment.algorand.client.token,
      environment.algorand.client.address,
      environment.algorand.client.port
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
    } catch (err: any) {
      if (err.response?.body?.message?.includes("account does not exist")) {
        // The address has never been funded
        return { optedIn: false, balance: BigInt(0) };
      }
      throw err;
    }
  }

  async optInToAsset(address: string, assetId: number) {
    const algod = new algosdk.Algodv2(
      environment.algorand.client.token,
      environment.algorand.client.address,
      environment.algorand.client.port
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
    console.log(`⏳ Waiting for confirmation of opt-in transaction ID: ${txId.txid}...`);
    const transactionCompletion = await algosdk.waitForConfirmation(algod, txId.txid, 5);
    console.log(`✅ Opted in to asset ID ${assetId} for address ${address}. Transaction ID: ${txId.txid}`);
    return transactionCompletion;
  }
}