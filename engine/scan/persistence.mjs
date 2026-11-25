import { extractOutside } from '../extract/outside.mjs';
import { extractState } from '../extract/state.mjs';
import { extractTransactions } from '../extract/transactions.mjs';

/** Outside clients, repository writes and cache state, then the transaction boundary those can leak through. */
export function persistenceFacts({ model, selected }) {
  const outsideCalls = extractOutside(model, selected);
  const stateFacts = extractState(model, selected);
  const stateWrites = stateFacts.filter((f) => f.family === 'state-write');
  const tx = extractTransactions(model, selected, { outside: outsideCalls, writes: stateWrites });
  return { outsideCalls, stateFacts, stateWrites, transactions: tx.facts, transactionCounts: tx.counts };
}
