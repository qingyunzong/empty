import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "dfa-mig-"));
}

export function writeJson(dir, name, value) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomDfa(rand, { stateCount, alphabet, risks }) {
  const states = Array.from({ length: stateCount }, (_, i) => `s${i}`);
  const transitions = {};
  const risk = {};
  for (const state of states) {
    transitions[state] = {};
    for (const symbol of alphabet) {
      transitions[state][symbol] = states[Math.floor(rand() * states.length)];
    }
    risk[state] = risks[Math.floor(rand() * risks.length)];
  }
  return { states, alphabet, start: states[0], risk, transitions };
}

export function bruteForceEqual(oldDfa, newDfa, m) {
  let sequences = [[]];
  let shortest = null;
  for (let length = 0; length <= m; length += 1) {
    const next = [];
    for (const seq of sequences) {
      let oldState = oldDfa.start;
      let newState = newDfa.start;
      for (const symbol of seq) {
        oldState = oldDfa.transitions[oldState][symbol];
        newState = newDfa.transitions[newState][symbol];
      }
      if (oldDfa.risk[oldState] !== newDfa.risk[newState]) {
        if (shortest === null) {
          shortest = seq;
        }
      }
      if (length < m) {
        for (const symbol of oldDfa.alphabet) {
          next.push([...seq, symbol]);
        }
      }
    }
    sequences = next;
    if (shortest !== null) {
      return { equal: false, witnessLength: shortest.length };
    }
  }
  return { equal: true, witnessLength: null };
}
