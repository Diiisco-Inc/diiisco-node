import { Job, scheduleJob } from 'node-schedule';
import { encode } from 'msgpackr';
import { RewardsPulse, RewardsPulseResponse } from '../types/messages';
import algorand from './algorand';
import diiiscoContract from './contract';
import { logger } from './logger';

interface RewardCandidate {
  walletAddr: string;
  lastPulse: number;
  pulseCount: number;
  amountHeld?: number;
  amountToReward?: number;
};

interface pusleRound {
  time: number;
  responses: number;
}

export class RewardsManager {
  node: any;
  algo: algorand;
  schedule: Job;
  pulseStore: pusleRound[] = [];
  rewardsStore: RewardCandidate[] = [];

  constructor(node: any, algo: algorand){
    this.node = node;
    this.algo = algo;

    // Schedule Daily Pulse at Midnight
    this.schedule = scheduleJob('30 * * * *', () => {
      // If New Day Start the Pulse Again
      if(new Date().getHours() === 0){
        this.resetPeriod();
      }

      // Send the Pulse Request
      this.pulseStore.push({
        time: Date.now(),
        responses: 0
      });
      this.pulse();

      // If the last pulse of the day, distribute rewards after 15 minutes
      if(new Date().getHours() === 23){
        setTimeout(() => {
          this.distributeRewards();
        }, 1000 * 60 * 15);
      }
    });
  }

  async pulse(){
    // Format the Pulse Message
    const pulseMessage: RewardsPulse = {
      role: 'rewards-pulse',
      timestamp: Date.now(),
      id: `${this.node.algo.account.addr}-${Date.now()}`,
      fromWalletAddr: this.node.algo.account.addr.toString(),
      payload: {
        date: new Date().toISOString().split('T')[0],
        pulse: this.pulseStore.length,
        inferenceTest: false
      }
    };

    // Sign and Send the Pulse Message
    pulseMessage.signature = await this.algo.signObject(pulseMessage);
    this.node.services.pubsub.publish('diiisco/models/1.0.0', encode(pulseMessage));
  }

  recievePulseResponse(res: RewardsPulseResponse){
    // Ensure resonse Was received within valid time (1 min)
    if (Date.now() - this.pulseStore[this.pulseStore.length -1].time > 1000 * 60){
      return;
    }

    // Check If It's the First Pulse of the Reward Period
    if (this.pulseStore.length <= 1){
      // If it is, add the wallet to the rewards store
      this.rewardsStore.push({
        walletAddr: res.fromWalletAddr,
        lastPulse: Date.now(),
        pulseCount: 1
      });
    } else {
      // Otherwise, update existing wallet entry
      const existing = this.rewardsStore.find(r => r.walletAddr === res.fromWalletAddr);
      if (existing && existing.lastPulse < this.pulseStore.length){
        existing.pulseCount += 1;
        existing.lastPulse = Date.now();
      }
    }
  }

  async distributeRewards(){
    // Get Eligible Wallets
    let eligibleWallets: RewardCandidate[] = this.rewardsStore.filter(r => r.pulseCount >= 24);

    // Get the Balance for the Reward Asset for each Eligible Wallet
    const balances = await Promise.all(eligibleWallets.map(async (r) => {
      const bal = await this.algo.checkIfOptedInToAsset(r.walletAddr, diiiscoContract.rewardAsset ?? diiiscoContract.asset);
      return { walletAddr: r.walletAddr, balance: Number(bal.balance)};
    }));

    // Calculate Total Held Across All Eligible Wallets
    const totalHeld = balances.reduce((acc, curr) => acc + curr.balance, 0);

    // Calculate and Store the Amount to Reward for Each Eligible Wallet
    eligibleWallets = eligibleWallets.map(r => {
      const bal = balances.find(b => b.walletAddr === r.walletAddr);
      if (bal){
        r.amountHeld = bal.balance;
        r.amountToReward = Math.floor((bal.balance / totalHeld) * 1000); // Reward Pool of 1000 DSCO Tokens
      }
      return r;
    });

    // Log the Rewards Distribution
    eligibleWallets.forEach(r => {
      logger.info(`💰 Rewarding ${r.amountToReward} DSCO to ${r.walletAddr} (held: ${r.amountHeld} DSCO over ${r.pulseCount} pulses)`);
    });
  }

  resetPeriod(){
    this.pulseStore = [];
    this.rewardsStore = [];
  }
};