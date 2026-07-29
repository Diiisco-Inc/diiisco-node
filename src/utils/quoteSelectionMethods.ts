import { QuoteCandidate } from "../types/messages";

// Selection strategies operate on candidates the quote engine has already
// enriched with DSCO balance, NFD status, and response latency — so they are
// pure, synchronous picks over that data.

// Select the cheapest quote (lowest max charge).
export function selectCheapestQuote(candidates: QuoteCandidate[]): QuoteCandidate {
  return candidates.reduce((prev, curr) =>
    (curr.quote.maxCharge ?? curr.quote.totalPrice) < (prev.quote.maxCharge ?? prev.quote.totalPrice) ? curr : prev
  );
}

// Select the first quote received (candidates are in receipt order).
export function selectFirstQuote(candidates: QuoteCandidate[]): QuoteCandidate {
  return candidates[0];
}

// Select the quote that arrived fastest after the request was issued.
export function selectFastestQuote(candidates: QuoteCandidate[]): QuoteCandidate {
  return candidates.reduce((prev, curr) =>
    curr.responseLatencyMs < prev.responseLatencyMs ? curr : prev
  );
}

// Select a random quote.
export function selectRandomQuote(candidates: QuoteCandidate[]): QuoteCandidate {
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Select the quote from the node holding the most DSCO (highest stake).
// Ties are broken in favour of a verified NFD, then faster response.
export function selectHighestStakeQuote(candidates: QuoteCandidate[]): QuoteCandidate {
  return candidates.reduce((prev, curr) => {
    if (curr.dscoBalance !== prev.dscoBalance) return curr.dscoBalance > prev.dscoBalance ? curr : prev;
    if (curr.nfdAuthenticated !== prev.nfdAuthenticated) return curr.nfdAuthenticated ? curr : prev;
    return curr.responseLatencyMs < prev.responseLatencyMs ? curr : prev;
  });
}
