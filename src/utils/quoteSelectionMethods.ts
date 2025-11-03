import { QuoteEvent } from "../types/messages";
import environment from '../environment/environment'
import algorand from "./algorand";

// Select the Cheapest Quote
export function selectCheapestQuote(quotes: QuoteEvent[]): QuoteEvent {
  return quotes.sort((a: QuoteEvent, b: QuoteEvent) => a.msg.payload.quote.totalPrice - b.msg.payload.quote.totalPrice)[0];
}

// Select the First Quote
export function selectFirstQuote(quotes: QuoteEvent[]): QuoteEvent {
  return quotes[0];
}

// Select a Random Quote
export function selectRandomQuote(quotes: QuoteEvent[]): QuoteEvent {
  const randomIndex = Math.floor(Math.random() * quotes.length);
  return quotes[randomIndex];
}

// Select the Quote From the Node Holding the most DSCO Tokens
export async function selectHighestStakeQuote(quotes: QuoteEvent[]): Promise<QuoteEvent> {
  const algo = new algorand();
  const balances = await Promise.all(quotes.map(async (quote) => {
    const balance = await algo.checkIfOptedIn(quote.msg.fromWalletAddr, environment.algorand.paymentAssetId);
    return { quote, balance };
  }));

  const highestBalance = balances.reduce((prev, curr) => {
    return (prev.balance > curr.balance) ? prev : curr;
  });

  return highestBalance.quote;
};