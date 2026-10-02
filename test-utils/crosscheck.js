'use strict';
// Independent cross-check enumerator: generates every order-preserving
// interleaving explicitly and interprets each sequence step by step.
const { hashValue, coreOf, checkInvariants } = require('../src/state');
const { applyStep } = require('../src/transitions');
const { initialState, totalOf } = require('../src/explore');

function allInterleavings(norm) {
  const actors = norm.actors;
  const pointers = actors.map(() => 0);
  const sequences = [];
  const walk = (current) => {
    let done = true;
    for (let ai = 0; ai < actors.length; ai++) {
      if (pointers[ai] >= actors[ai].steps.length) continue;
      done = false;
      pointers[ai]++;
      current.push(`${actors[ai].name}#${pointers[ai] - 1}`);
      walk(current);
      current.pop();
      pointers[ai]--;
    }
    if (done) sequences.push([...current]);
  };
  walk([]);
  return sequences;
}

function compareSequences(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function stepOf(norm, label) {
  const hash = label.lastIndexOf('#');
  const actorName = label.slice(0, hash);
  const index = Number(label.slice(hash + 1));
  const actor = norm.actors.find((a) => a.name === actorName);
  return actor.steps[index];
}

// Replays every interleaving independently and derives the same facts the
// explorer reports: reachable config count, violation existence, the
// lexicographically smallest violating prefix, and terminal state hashes.
function enumerate(norm) {
  const total = totalOf(norm);
  const initial = initialState(norm);
  const reachableKeys = new Set();
  const terminalHashes = new Set();
  let sawViolation = false;
  let minViolatingPrefix = null;
  for (const sequence of allInterleavings(norm)) {
    let state = initial;
    const pointers = norm.actors.map(() => 0);
    const key = () => hashValue(coreOf(state)) + '|' + pointers.join(',');
    reachableKeys.add(key());
    if (checkInvariants(state, total).length > 0) {
      sawViolation = true;
      if (minViolatingPrefix === null) minViolatingPrefix = [];
    }
    sequence.forEach((label, i) => {
      const { state: next } = applyStep(state, stepOf(norm, label), label);
      state = next;
      const hash = label.lastIndexOf('#');
      const actorName = label.slice(0, hash);
      const ai = norm.actors.findIndex((a) => a.name === actorName);
      pointers[ai]++;
      reachableKeys.add(key());
      if (checkInvariants(state, total).length > 0) {
        sawViolation = true;
        const prefix = sequence.slice(0, i + 1);
        if (minViolatingPrefix === null || compareSequences(prefix, minViolatingPrefix) < 0) {
          minViolatingPrefix = prefix;
        }
      }
    });
    terminalHashes.add(hashValue(coreOf(state)));
  }
  return {
    reachable: reachableKeys.size,
    sawViolation,
    minViolatingPrefix,
    terminals: [...terminalHashes].sort(),
  };
}

module.exports = { allInterleavings, enumerate, compareSequences };
