/**
 * Brute-force cross-check for short automata: enumerate every word up to a
 * derived length and compare the full I/O behaviour (outputs on every step,
 * acceptance at every prefix) of both machines by direct simulation.
 *
 * This is a sanity check that backs up the product-space BFS proof; it runs
 * only when the number of words stays within the given cap.
 */

import { Machine } from "./machine";

export interface EnumerationReport {
  ok: boolean;
  checkedWords: number;
  maxLength: number;
  counterexample?: string[];
}

export function enumerationMaxLength(alphabetSize: number, maxWords: number): number {
  const k = Math.max(alphabetSize, 1);
  let total = 1; // empty word
  let level = 1;
  let length = 0;
  while (length < 64) {
    level *= k;
    if (total + level > maxWords) break;
    total += level;
    length++;
  }
  return length;
}

export function verifyByEnumeration(
  m1: Machine,
  m2: Machine,
  initRegs: number[],
  maxWords: number,
): EnumerationReport {
  const maxLength = enumerationMaxLength(m1.alphabet.length, maxWords);
  let checked = 0;

  function dfs(s1: string, r1: number[], s2: string, r2: number[], word: string[], depth: number): string[] | null {
    checked++;
    if (m1.isAccepting(s1) !== m2.isAccepting(s2)) return word;
    if (depth >= maxLength) return null;
    for (let i = 0; i < m1.alphabet.length; i++) {
      const n1 = m1.step(s1, r1, i);
      const n2 = m2.step(s2, r2, i);
      const nextWord = [...word, m1.alphabet[i]];
      if (n1.output !== n2.output) return nextWord;
      const bad = dfs(n1.state, n1.regs, n2.state, n2.regs, nextWord, depth + 1);
      if (bad) return bad;
    }
    return null;
  }

  const bad = dfs(m1.initial, initRegs.slice(), m2.initial, initRegs.slice(), [], 0);
  if (bad) return { ok: false, checkedWords: checked, maxLength, counterexample: bad };
  return { ok: true, checkedWords: checked, maxLength };
}
