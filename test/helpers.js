'use strict';

// Base device tree used across tests (3 levels, 3 threshold keys in play).
function baseTree() {
  return {
    thresholds: { temp: 10, hum: 20 },
    children: {
      a: {
        thresholds: { temp: 15 },
        children: {
          b: { thresholds: {}, children: {} },
        },
      },
      c: { thresholds: {}, children: {} },
    },
  };
}

// Linear history: g(sealed) -> a -> b -> c -> d.
function makeRepo() {
  return {
    base: baseTree(),
    commits: [
      { hash: 'g', parents: [], sealed: true, patch: { set: { '/c': { temp: 5 } } } },
      { hash: 'a', parents: ['g'], patch: { set: { '/a': { temp: 16 } } } },
      { hash: 'b', parents: ['a'], patch: { set: { '/a/b': { hum: 30 } } } },
      {
        hash: 'c',
        parents: ['b'],
        patch: { set: { '/a/b': { press: 101 } }, unset: { '/a': ['temp'] } },
      },
      { hash: 'd', parents: ['c'], patch: { set: { '/c': { hum: 21 } } } },
    ],
    head: 'd',
  };
}

// Branched history for merge tests: m0 -> l1, m0 -> r1.
function makeBranchRepo(leftPatch, rightPatch) {
  return {
    base: baseTree(),
    commits: [
      { hash: 'm0', parents: [], patch: {} },
      { hash: 'l1', parents: ['m0'], patch: leftPatch },
      { hash: 'r1', parents: ['m0'], patch: rightPatch },
    ],
    head: 'r1',
  };
}

module.exports = { baseTree, makeRepo, makeBranchRepo };
