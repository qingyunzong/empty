import { GrammarInput } from '../src/index';

/** Deterministic PRNG (mulberry32) so test runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RandomGrammar {
  grammar: GrammarInput;
  sequence: string[];
}

const NONTERMINALS = ['S', 'A', 'B', 'C'];
const TERMINALS = ['a', 'b', 'c'];

/** Small random weighted CFG, possibly recursive, possibly with epsilon rules. */
export function randomCase(rand: () => number): RandomGrammar {
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const ntCount = 2 + Math.floor(rand() * 3); // 2..4 nonterminals
  const nts = NONTERMINALS.slice(0, ntCount);

  const rules: GrammarInput['rules'] = [];
  let nextId = 1;
  for (const nt of nts) {
    const ruleCount = 1 + Math.floor(rand() * 3); // 1..3 rules per nonterminal
    for (let r = 0; r < ruleCount; r++) {
      let rhs: string[];
      if (rand() < 0.12) {
        rhs = []; // epsilon
      } else {
        const len = 1 + Math.floor(rand() * 3); // 1..3 symbols
        rhs = [];
        for (let k = 0; k < len; k++) {
          rhs.push(rand() < 0.55 ? pick(TERMINALS) : pick(nts));
        }
      }
      const cost = rand() < 0.3 ? 0 : 1 + Math.floor(rand() * 3); // 0..3
      rules.push({ id: nextId++, lhs: nt, rhs, cost });
    }
  }

  const seqLen = Math.floor(rand() * 7); // 0..6 tokens
  const sequence: string[] = [];
  for (let i = 0; i < seqLen; i++) sequence.push(pick(TERMINALS));

  return { grammar: { start: 'S', rules }, sequence };
}
