'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { GenealogyError, buildGraph, toNFA } = require('./genealogy');
const {
  determinize,
  minimize,
  equivalent,
  reachableClosureNFA,
  reachableClosureDFA,
} = require('./dfa');
const journal = require('./journal');

function readJsonl(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new GenealogyError('BAD_FILE', `cannot read file "${file}"`);
  }
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l, i) => {
      try {
        return JSON.parse(l);
      } catch {
        throw new GenealogyError('BAD_FILE', `${file}:${i + 1}: invalid JSON`);
      }
    });
}

class TraceabilitySystem {
  constructor(stateDir) {
    this.stateDir = stateDir;
    this.journalFile = path.join(stateDir, 'journal.jsonl');
    this.graph = new Map();
    this.recoveredTo = 0;
  }

  // Replay complete layers from the journal; torn tails are discarded.
  recover() {
    const { layers, recoveredTo } = journal.readJournal(this.journalFile);
    let graph = new Map();
    for (const records of layers) graph = buildGraph(records, graph);
    this.graph = graph;
    this.recoveredTo = recoveredTo;
    return { recoveredTo };
  }

  // Determinize + minimize the current genealogy and verify the core
  // invariant: merging equivalent traceability views must not change the
  // reachable defect set.
  stats() {
    const nfa = toNFA(this.graph);
    const dfa = determinize(nfa);
    const min = minimize(dfa);
    const before = reachableClosureNFA(nfa);
    const after = reachableClosureDFA(dfa);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error('internal invariant violated: reachable defect set changed during merge');
    }
    return { minStates: min.states.size };
  }

  // Import a batch file as a new savepoint layer. Validation happens before
  // the journal is touched, so a rejected import leaves no trace.
  importFile(file) {
    const records = readJsonl(file);
    buildGraph(records, this.graph); // validate against current state first
    const layer = journal.appendLayer(this.journalFile, this.recoveredTo + 1, records);
    this.graph = buildGraph(records, this.graph);
    this.recoveredTo = layer;
    const { minStates } = this.stats();
    return { layer, batches: records.length, minStates, recoveredTo: this.recoveredTo };
  }

  // Compare two rule versions (genealogy files) without importing them.
  // Equal -> canonical-form certificate; unequal -> shortest witness string.
  equivFiles(fileA, fileB) {
    const build = (file) => minimize(determinize(toNFA(buildGraph(readJsonl(file)))));
    const minA = build(fileA);
    const minB = build(fileB);
    const res = equivalent(minA, minB);
    return {
      equal: res.equal,
      witness: res.equal ? null : res.witness,
      certificate: res.equal ? res.certificate : null,
      minStates: [minA.states.size, minB.states.size],
    };
  }

  // Roll back to the state as of the end of layer n (layers > n discarded).
  rollback(n) {
    if (!Number.isInteger(n) || n < 0) {
      throw new GenealogyError('BAD_LAYER', `rollback layer must be a non-negative integer`);
    }
    if (n > this.recoveredTo) {
      throw new GenealogyError(
        'BAD_LAYER',
        `rollback layer ${n} beyond last complete layer ${this.recoveredTo}`
      );
    }
    const { layers } = journal.readJournal(this.journalFile);
    journal.rewriteJournal(this.journalFile, layers.slice(0, n));
    this.recover();
    const { minStates } = this.stats();
    return { recoveredTo: this.recoveredTo, minStates };
  }
}

module.exports = { TraceabilitySystem, readJsonl };
