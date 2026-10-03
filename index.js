'use strict';

// 设备事件账本：set 补丁 {key, old, new}，apply 时当前值必须等于 old。
// 约定：键不存在以 null 表示；补丁 new 为 null 表示删除该键。
// 每条记录含 prevHash / stateHash / hash；sealed 标志不参与哈希，
// 因此事后封存不会使历史哈希失效。

const crypto = require('node:crypto');
const fs = require('node:fs');
const { parseArgs } = require('node:util');

const EXIT_OK = 0;
const EXIT_CONFLICT = 1;
const EXIT_USAGE = 2;

class LedgerError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.details = details || {};
  }
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

const GENESIS_HASH = sha256('device-event-ledger:genesis');

function createLedger() {
  return { records: [], cursor: 0 };
}

function cloneLedger(ledger) {
  return structuredClone(ledger);
}

function getValue(state, key) {
  return Object.prototype.hasOwnProperty.call(state, key) ? state[key] : null;
}

function applyPatchToState(state, patch) {
  if (patch.new === null) delete state[patch.key];
  else state[patch.key] = patch.new;
}

function inverseOf(patch) {
  return { key: patch.key, old: patch.new, new: patch.old };
}

function stateHashOf(state) {
  return sha256(stableStringify(state));
}

function hashRecordBody(rec) {
  return sha256(stableStringify({
    seq: rec.seq,
    patch: rec.patch,
    inverse: rec.inverse,
    prevHash: rec.prevHash,
    stateHash: rec.stateHash,
  }));
}

function makeRecord(seq, patch, prevHash, state) {
  const rec = {
    seq,
    patch: { key: patch.key, old: patch.old, new: patch.new },
    inverse: inverseOf(patch),
    sealed: false,
    prevHash,
    stateHash: stateHashOf(state),
  };
  rec.hash = hashRecordBody(rec);
  return rec;
}

function validatePatch(patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new LedgerError(EXIT_USAGE, 'patch must be an object {key, old, new}');
  }
  if (typeof patch.key !== 'string' || patch.key.length === 0) {
    throw new LedgerError(EXIT_USAGE, 'patch.key must be a non-empty string');
  }
  if (!('old' in patch) || !('new' in patch)) {
    throw new LedgerError(EXIT_USAGE, 'patch must contain old and new');
  }
  if (patch.old === undefined || patch.new === undefined) {
    throw new LedgerError(EXIT_USAGE, 'patch old/new must be JSON values (use null for absent)');
  }
}

function validateLedger(ledger) {
  if (ledger === null || typeof ledger !== 'object' || !Array.isArray(ledger.records) ||
      !Number.isInteger(ledger.cursor) || ledger.cursor < 0 || ledger.cursor > ledger.records.length) {
    throw new LedgerError(EXIT_USAGE, 'invalid ledger shape');
  }
}

function guardHolds(state, patch) {
  return stableStringify(getValue(state, patch.key)) === stableStringify(patch.old);
}

// 计算前 n 条记录应用后的状态（默认算到游标处）。
function computeState(ledger, upto) {
  const n = upto === undefined ? ledger.cursor : upto;
  const state = {};
  for (let i = 0; i < n; i++) applyPatchToState(state, ledger.records[i].patch);
  return state;
}

function stateOf(ledger) {
  validateLedger(ledger);
  return computeState(ledger);
}

// 追加提交。若游标不在末尾（曾 undo），新 apply 截断可 redo 的尾部，旧分支不可恢复。
function apply(ledger, patch) {
  validateLedger(ledger);
  validatePatch(patch);
  const state = computeState(ledger);
  if (!guardHolds(state, patch)) {
    throw new LedgerError(EXIT_CONFLICT, `apply guard failed for key "${patch.key}"`, {
      key: patch.key,
      expected: patch.old,
      actual: getValue(state, patch.key),
    });
  }
  if (ledger.cursor < ledger.records.length) ledger.records.length = ledger.cursor;
  applyPatchToState(state, patch);
  const prevHash = ledger.records.length ? ledger.records[ledger.records.length - 1].hash : GENESIS_HASH;
  ledger.records.push(makeRecord(ledger.records.length + 1, patch, prevHash, state));
  ledger.cursor = ledger.records.length;
  return ledger.records[ledger.cursor - 1];
}

// undo/redo 只移动游标，不删除历史。
function undo(ledger) {
  validateLedger(ledger);
  if (ledger.cursor === 0) return false;
  ledger.cursor -= 1;
  return true;
}

function redo(ledger) {
  validateLedger(ledger);
  if (ledger.cursor >= ledger.records.length) return false;
  ledger.cursor += 1;
  return true;
}

function seal(ledger, seq) {
  validateLedger(ledger);
  if (!Number.isInteger(seq) || seq < 1 || seq > ledger.records.length) {
    throw new LedgerError(EXIT_USAGE, `invalid seq ${seq}`);
  }
  ledger.records[seq - 1].sealed = true;
}

// 重写第 seq 条（1 基）提交并从该点重放。全程在克隆的临时账本上进行，
// 任何失败（守卫冲突 / sealed / 参数错误）都不会影响原账本。
// 成功返回 { ledger, hashMap }，hashMap 为旧哈希 -> 新哈希映射。
function rewrite(ledger, seq, newPatch) {
  validateLedger(ledger);
  validatePatch(newPatch);
  if (!Number.isInteger(seq) || seq < 1 || seq > ledger.records.length) {
    throw new LedgerError(EXIT_USAGE, `invalid seq ${seq}`);
  }
  const draft = cloneLedger(ledger);
  const target = draft.records[seq - 1];
  if (target.sealed) {
    throw new LedgerError(EXIT_USAGE, `commit ${seq} is sealed and cannot be rewritten`);
  }
  target.patch = { key: newPatch.key, old: newPatch.old, new: newPatch.new };
  target.inverse = inverseOf(target.patch);

  const state = computeState(draft, seq - 1);
  const hashMap = {};
  let prevHash = seq >= 2 ? draft.records[seq - 2].hash : GENESIS_HASH;
  for (let i = seq - 1; i < draft.records.length; i++) {
    const rec = draft.records[i];
    if (!guardHolds(state, rec.patch)) {
      throw new LedgerError(EXIT_CONFLICT, `replay conflict at commit ${i + 1}`, {
        seq: i + 1,
        key: rec.patch.key,
        expected: rec.patch.old,
        actual: getValue(state, rec.patch.key),
      });
    }
    applyPatchToState(state, rec.patch);
    const oldHash = rec.hash;
    rec.prevHash = prevHash;
    rec.stateHash = stateHashOf(state);
    rec.hash = hashRecordBody(rec);
    hashMap[oldHash] = rec.hash;
    prevHash = rec.hash;
  }
  return { ledger: draft, hashMap };
}

function main(argv) {
  const command = argv[2];
  if (command !== 'rewrite') {
    console.error('usage: node index.js rewrite --book <file> --seq <n> --patch <file> --out <file>');
    return EXIT_USAGE;
  }
  let opts;
  try {
    ({ values: opts } = parseArgs({
      args: argv.slice(3),
      options: {
        book: { type: 'string' },
        seq: { type: 'string' },
        patch: { type: 'string' },
        out: { type: 'string' },
      },
      strict: true,
    }));
  } catch (err) {
    console.error(`argument error: ${err.message}`);
    return EXIT_USAGE;
  }
  if (!opts.book || !opts.seq || !opts.patch || !opts.out) {
    console.error('missing required option: --book --seq --patch --out');
    return EXIT_USAGE;
  }
  const seq = Number(opts.seq);
  let book, patch;
  try {
    book = JSON.parse(fs.readFileSync(opts.book, 'utf8'));
    patch = JSON.parse(fs.readFileSync(opts.patch, 'utf8'));
  } catch (err) {
    console.error(`cannot read input: ${err.message}`);
    return EXIT_USAGE;
  }
  try {
    const { ledger, hashMap } = rewrite(book, seq, patch);
    fs.writeFileSync(opts.out, JSON.stringify({ ledger, hashMap }, null, 2) + '\n');
    return EXIT_OK;
  } catch (err) {
    if (err instanceof LedgerError) {
      console.error(`${err.message} ${JSON.stringify(err.details)}`);
      return err.code;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = {
  EXIT_OK,
  EXIT_CONFLICT,
  EXIT_USAGE,
  LedgerError,
  GENESIS_HASH,
  stableStringify,
  stateHashOf,
  inverseOf,
  createLedger,
  cloneLedger,
  computeState,
  stateOf,
  apply,
  undo,
  redo,
  seal,
  rewrite,
  main,
};
