import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCommand, canonical, checkInvariants, initialState, verifyMigrationChain, EXIT, STATUS,
} from '../src/ledger.js';

const MAX_DEPTH = 6;

const TEMPLATES = [
  { type: 'transfer', id: 't1', from: 'alice', to: 'bob', amount: 100 },
  { type: 'transfer', id: 't2', from: 'bob', to: 'alice', amount: 40 },
  { type: 'reverse', tx: 't1' },
  { type: 'reverse', tx: 't1', amount: 30 },
  { type: 'reverse', tx: 't1', amount: 0 },
  { type: 'reverse', tx: 't1', amount: 70 },
  { type: 'reverse', tx: 't2' },
  { type: 'reverseReversal', tx: 't1' },
  { type: 'reverseReversal', tx: 't2' },
  { type: 'freeze', account: 'bob', amount: 60 },
  { type: 'freeze', account: 'alice', amount: 50 },
  { type: 'unfreeze', account: 'bob', amount: 30 },
  { type: 'unfreeze', account: 'bob', amount: 80 },
  { type: 'unfreeze', account: 'alice', amount: 20 },
  { type: 'teleport', account: 'alice', amount: 10 },
];

function coreOf(state) {
  return { accounts: state.accounts, transactions: state.transactions };
}

function coreKey(state) {
  return canonical(coreOf(state));
}

// Independent oracle: decides the expected exit code purely from the spec,
// without using the library's transition logic.
function oracleExitCode(core, cmd) {
  const acc = (name) => core.accounts[name] ?? { available: 0, frozen: 0, locked: 0 };
  const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  switch (cmd.type) {
    case 'transfer': {
      if (!positive(cmd.amount)) return EXIT.AMOUNT_OUT_OF_RANGE;
      if (cmd.from === cmd.to) return EXIT.ILLEGAL_TRANSITION;
      if (core.transactions[cmd.id]) return EXIT.ILLEGAL_TRANSITION;
      return acc(cmd.from).available >= cmd.amount ? EXIT.OK : EXIT.AMOUNT_OUT_OF_RANGE;
    }
    case 'reverse': {
      const tx = core.transactions[cmd.tx];
      if (!tx) return EXIT.ILLEGAL_TRANSITION;
      if (tx.status !== STATUS.POSTED) return EXIT.ILLEGAL_TRANSITION;
      const remaining = tx.amount - tx.reversedAmount;
      const amount = cmd.amount === undefined ? remaining : cmd.amount;
      if (!positive(amount) || amount > remaining) return EXIT.AMOUNT_OUT_OF_RANGE;
      const to = acc(tx.to);
      return to.available + (to.frozen - to.locked) >= amount ? EXIT.OK : EXIT.AMOUNT_OUT_OF_RANGE;
    }
    case 'reverseReversal': {
      const tx = core.transactions[cmd.tx];
      if (!tx) return EXIT.ILLEGAL_TRANSITION;
      if (tx.status !== STATUS.REVERSED) return EXIT.ILLEGAL_TRANSITION;
      return acc(tx.from).available >= tx.reversedAmount ? EXIT.OK : EXIT.AMOUNT_OUT_OF_RANGE;
    }
    case 'freeze': {
      if (!positive(cmd.amount)) return EXIT.AMOUNT_OUT_OF_RANGE;
      return acc(cmd.account).available >= cmd.amount ? EXIT.OK : EXIT.AMOUNT_OUT_OF_RANGE;
    }
    case 'unfreeze': {
      if (!positive(cmd.amount)) return EXIT.AMOUNT_OUT_OF_RANGE;
      const a = acc(cmd.account);
      return a.frozen - a.locked >= cmd.amount ? EXIT.OK : EXIT.AMOUNT_OUT_OF_RANGE;
    }
    default:
      return EXIT.UNKNOWN_COMMAND;
  }
}

test(`枚举所有 n<=${MAX_DEPTH} 操作序列，对照独立 oracle 与不变量`, () => {
  const seed = initialState();
  seed.accounts.alice = { available: 200, frozen: 0, locked: 0 };
  seed.accounts.bob = { available: 200, frozen: 0, locked: 0 };

  const seen = new Set([coreKey(seed)]);
  let frontier = [seed];
  let transitions = 0;
  let okTransitions = 0;
  const exitCounts = new Map();

  for (let depth = 1; depth <= MAX_DEPTH; depth += 1) {
    const next = [];
    const nextKeys = new Set();
    for (const state of frontier) {
      const coreBefore = canonical(coreOf(state));
      for (const template of TEMPLATES) {
        transitions += 1;
        const expected = oracleExitCode(coreOf(state), template);
        const clone = structuredClone(state);
        const out = applyCommand(clone, template);
        exitCounts.set(out.exitCode, (exitCounts.get(out.exitCode) ?? 0) + 1);

        assert.equal(
          out.exitCode, expected,
          `depth ${depth} cmd ${canonical(template)}: lib exit ${out.exitCode} != oracle exit ${expected}`,
        );

        if (out.ok) {
          okTransitions += 1;
          assert.deepEqual(checkInvariants(clone), [], `invariants broken by ${canonical(template)}`);
          assert.ok(verifyMigrationChain(clone), 'migration hash chain broken');
          const key = coreKey(clone);
          if (!seen.has(key) && !nextKeys.has(key)) {
            nextKeys.add(key);
            next.push(clone);
          }
        } else {
          // Failed commands must not touch funds, freezes, or transactions.
          assert.equal(canonical(coreOf(clone)), coreBefore, `failed cmd mutated core: ${canonical(template)}`);
        }
      }
    }
    for (const key of nextKeys) seen.add(key);
    frontier = next;
    if (frontier.length === 0) break;
  }

  assert.ok(okTransitions > 0, 'enumeration must reach successful transitions');
  assert.ok(exitCounts.get(EXIT.ILLEGAL_TRANSITION) > 0, 'must exercise exit15');
  assert.ok(exitCounts.get(EXIT.AMOUNT_OUT_OF_RANGE) > 0, 'must exercise exit16');
  assert.ok(exitCounts.get(EXIT.UNKNOWN_COMMAND) > 0, 'must exercise exit17');
  console.log(
    `enumerated depth<=${MAX_DEPTH}: ${transitions} transitions, `
    + `${okTransitions} applied, ${seen.size} unique cores, `
    + `exits ${JSON.stringify(Object.fromEntries(exitCounts))}`,
  );
});
