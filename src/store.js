import fs from 'node:fs';
import path from 'node:path';
import { EvpackError, E_DUP_RULE, E_EVIDENCE_GONE, E_INVALID } from './errors.js';
import { matchWhere, validateWhere, isNull } from './algebra.js';
import { hashValue } from './canonical.js';

export const STORE_FILE = 'evpack.store.json';
export const STATES = ['asserted', 'unknown', 'retracted'];

function normalizeRow(raw, source) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EvpackError(E_INVALID, `bad evidence row in ${source}`);
  }
  const { key, state = 'asserted', attrs, ...rest } = raw;
  if (typeof key !== 'string' || key === '') {
    throw new EvpackError(E_INVALID, `evidence row in ${source} requires a string "key"`);
  }
  if (!STATES.includes(state)) {
    throw new EvpackError(E_INVALID, `evidence '${key}' has bad state '${state}' (expected ${STATES.join('/')})`);
  }
  const flat = Object.keys(rest);
  const resolved = attrs !== undefined ? attrs : rest;
  if (resolved === null || typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new EvpackError(E_INVALID, `evidence '${key}' has non-object attrs`);
  }
  void flat;
  return { key, state, attrs: resolved };
}

function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new EvpackError(E_INVALID, 'rule must be an object');
  }
  const { id, priority = 0, where = [] } = raw;
  if (typeof id !== 'string' || id === '') throw new EvpackError(E_INVALID, 'rule requires a string "id"');
  if (!Number.isInteger(priority)) throw new EvpackError(E_INVALID, `rule '${id}' priority must be an integer`);
  validateWhere(where);
  return { id, priority, where };
}

function readEvidenceDir(dir) {
  const rows = [];
  const jsonl = path.join(dir, 'evidence.jsonl');
  if (fs.existsSync(jsonl)) {
    const lines = fs.readFileSync(jsonl, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t) rows.push(normalizeRow(JSON.parse(t), `evidence.jsonl:${i + 1}`));
    });
  }
  const evDir = path.join(dir, 'evidence');
  if (fs.existsSync(evDir) && fs.statSync(evDir).isDirectory()) {
    for (const name of fs.readdirSync(evDir).filter((n) => n.endsWith('.json')).sort()) {
      const parsed = JSON.parse(fs.readFileSync(path.join(evDir, name), 'utf8'));
      const list = Array.isArray(parsed) ? parsed : [parsed];
      list.forEach((raw, i) => rows.push(normalizeRow(raw, `evidence/${name}[${i}]`)));
    }
  }
  return rows;
}

const indexable = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

export class PackStore {
  constructor(dir) {
    this.dir = dir;
    this.evidence = new Map(); // key -> { attrs, state }
    this.rules = []; // [{ id, priority, where }]
    this.ruleVersion = 0;
    // Inverted indexes
    this.ruleToKeys = new Map(); // ruleId -> Set(key)   (rule hit set)
    this.keyToRules = new Map(); // key -> Set(ruleId)   (reverse map for incremental retract)
    this.fieldIndex = new Map(); // field -> Map(JSON(value) -> Set(key))
    this.stats = { ruleMatchEvals: 0 }; // instrumentation: proves retract never rescans
  }

  // (Re)build a pack from a directory: evidence.jsonl + evidence/*.json.
  // If a store already exists, its rules and ruleVersion are preserved.
  static loadDir(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      throw new EvpackError(E_INVALID, `not a directory: ${dir}`);
    }
    const store = new PackStore(dir);
    const storePath = path.join(dir, STORE_FILE);
    if (fs.existsSync(storePath)) {
      const prev = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      store.rules = (prev.rules ?? []).map(normalizeRule);
      store.ruleVersion = prev.ruleVersion ?? 0;
    }
    for (const row of readEvidenceDir(dir)) {
      if (store.evidence.has(row.key)) {
        throw new EvpackError(E_INVALID, `duplicate evidence key: '${row.key}'`);
      }
      store.evidence.set(row.key, { attrs: row.attrs, state: row.state });
    }
    store.rebuildIndexes();
    return store;
  }

  // Open an existing pack store (for rule/retract/verify/cert commands).
  static open(dir) {
    const storePath = path.join(dir, STORE_FILE);
    if (!fs.existsSync(storePath)) {
      throw new EvpackError(E_INVALID, `no pack store in '${dir}'; run 'load <dir>' first`);
    }
    const data = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const store = new PackStore(dir);
    for (const [key, e] of Object.entries(data.evidence ?? {})) {
      store.evidence.set(key, { attrs: e.attrs, state: e.state });
    }
    store.rules = (data.rules ?? []).map(normalizeRule);
    store.ruleVersion = data.ruleVersion ?? 0;
    store.rebuildIndexes();
    return store;
  }

  save() {
    const data = {
      version: 1,
      ruleVersion: this.ruleVersion,
      rules: this.rules,
      evidence: Object.fromEntries(this.evidence),
    };
    fs.writeFileSync(path.join(this.dir, STORE_FILE), JSON.stringify(data, null, 2) + '\n');
  }

  rebuildIndexes() {
    this.ruleToKeys = new Map();
    this.keyToRules = new Map();
    this.fieldIndex = new Map();
    this.stats = { ruleMatchEvals: 0 };
    for (const [key, e] of this.evidence) {
      for (const [field, value] of Object.entries(e.attrs)) {
        if (!indexable(value)) continue;
        let byValue = this.fieldIndex.get(field);
        if (!byValue) this.fieldIndex.set(field, (byValue = new Map()));
        const vk = JSON.stringify(value);
        let set = byValue.get(vk);
        if (!set) byValue.set(vk, (set = new Set()));
        set.add(key);
      }
    }
    for (const rule of this.rules) this.indexRule(rule);
  }

  indexRule(rule) {
    const set = new Set();
    for (const [key, e] of this.evidence) {
      this.stats.ruleMatchEvals++;
      if (matchWhere(e.attrs, rule.where)) {
        set.add(key);
        let rev = this.keyToRules.get(key);
        if (!rev) this.keyToRules.set(key, (rev = new Set()));
        rev.add(rule.id);
      }
    }
    this.ruleToKeys.set(rule.id, set);
  }

  addRule(raw) {
    const rule = normalizeRule(raw);
    if (this.rules.some((r) => r.id === rule.id)) {
      throw new EvpackError(E_DUP_RULE, `rule '${rule.id}' already exists`);
    }
    this.rules.push(rule);
    this.ruleVersion++;
    this.indexRule(rule); // incremental: only the new rule is matched against evidence
    return rule;
  }

  // Incremental retraction: touches only the reverse index entry for this key.
  // Never rescans evidence rows or re-evaluates rules (scannedRows stays 0).
  retract(key) {
    const e = this.evidence.get(key);
    if (!e || e.state === 'retracted') {
      throw new EvpackError(E_EVIDENCE_GONE, `evidence '${key}' is gone or already retracted`);
    }
    e.state = 'retracted';
    const affectedRules = [...(this.keyToRules.get(key) ?? [])].sort();
    return { key, affectedRules, scannedRows: 0 };
  }

  // Candidate selection for a claim where-clause. Equality predicates are
  // served from the inverted field index; otherwise falls back to a scan.
  candidates(where = []) {
    let best = null;
    for (const p of where) {
      if (p.op === 'eq' && indexable(p.value)) {
        const set = this.fieldIndex.get(p.field)?.get(JSON.stringify(p.value));
        const size = set ? set.size : 0;
        if (!best || size < best.size) best = { set: set ?? new Set(), size };
      }
    }
    const pool = best ? [...best.set] : [...this.evidence.keys()];
    const matched = [];
    let scanned = 0;
    for (const key of pool) {
      scanned++;
      if (matchWhere(this.evidence.get(key).attrs, where)) matched.push(key);
    }
    matched.sort();
    return { keys: matched, scanned };
  }

  getState(key) {
    return this.evidence.get(key)?.state;
  }

  inputHash() {
    const evidence = [...this.evidence.entries()]
      .map(([key, e]) => ({ key, state: e.state, attrs: e.attrs }))
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return hashValue({ evidence, rules: this.rules, ruleVersion: this.ruleVersion });
  }
}
