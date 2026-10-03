'use strict';

// Core library for the dosing pump scheduler.
// Offline, single machine, Node.js standard library only.

const fs = require('node:fs');
const path = require('node:path');

const JOURNAL_FILE = 'journal.jsonl';
const LEDGER_FILE = 'dose_ledger.jsonl';
const PLAN_SNAPSHOT = 'plan.json';
const PUMPS_SNAPSHOT = 'pumps.json';
const META_FILE = 'meta.json';
const RECOVERED_FILE = 'recovered.json';
const MODIFY_RESULT_FILE = 'modify_result.json';

class PlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlanError';
  }
}

function doseKey(pumpId, slot) {
  return `${pumpId}#${slot}`;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Plan validation. Throws PlanError (-> CLI exit code 2) on:
//   - unknown pump
//   - negative dose
//   - slot overlap (same pump+slot twice, or overlapping time windows)
// ---------------------------------------------------------------------------
function validatePlan(plan, pumps) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.doses)) {
    throw new PlanError('plan must be an object with a "doses" array');
  }
  const known = new Set((pumps.pumps || []).map((p) => p.pump_id));
  const byPump = new Map();
  plan.doses.forEach((d, i) => {
    const where = `doses[${i}]`;
    if (d === null || typeof d !== 'object' || Array.isArray(d)) {
      throw new PlanError(`${where}: entry must be an object`);
    }
    if (typeof d.pump_id !== 'string' || d.pump_id === '') {
      throw new PlanError(`${where}: missing pump_id`);
    }
    if (!known.has(d.pump_id)) {
      throw new PlanError(`unknown pump: ${d.pump_id}`);
    }
    if (!Number.isInteger(d.slot) || d.slot < 0) {
      throw new PlanError(`${where}: invalid slot ${String(d.slot)}`);
    }
    if (typeof d.dose !== 'number' || Number.isNaN(d.dose) || d.dose < 0) {
      throw new PlanError(`negative dose for pump ${d.pump_id} slot ${d.slot}`);
    }
    const siblings = byPump.get(d.pump_id) || [];
    for (const other of siblings) {
      if (other.slot === d.slot) {
        throw new PlanError(
          `slot overlap: pump ${d.pump_id} slot ${d.slot} defined more than once`,
        );
      }
      const windowed = [d, other].every(
        (e) => typeof e.start === 'number' && typeof e.end === 'number',
      );
      if (windowed && d.start < other.end && other.start < d.end) {
        throw new PlanError(
          `slot overlap: pump ${d.pump_id} slots ${other.slot} and ${d.slot} overlap in time`,
        );
      }
    }
    siblings.push(d);
    byPump.set(d.pump_id, siblings);
  });
}

// ---------------------------------------------------------------------------
// Journal (append-only event log inside the journal directory)
// ---------------------------------------------------------------------------
function journalPath(journalDir) {
  return path.join(journalDir, JOURNAL_FILE);
}

function appendJournal(journalDir, record) {
  fs.appendFileSync(journalPath(journalDir), JSON.stringify(record) + '\n');
}

function readJournal(journalDir) {
  const file = journalPath(journalDir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Dose ledger (JSONL). Idempotency key for a dose is pump_id + slot.
// ---------------------------------------------------------------------------
function readLedger(ledgerFile) {
  if (!fs.existsSync(ledgerFile)) return [];
  return fs
    .readFileSync(ledgerFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// Appends a ledger record. For kind "dose" the idempotency key
// (pump_id + slot) is enforced: a duplicate effect is never accumulated.
// Returns true when a record was appended.
function appendLedger(ledgerFile, record) {
  if (record.kind === 'dose') {
    const existing = readLedger(ledgerFile);
    if (existing.some((e) => e.kind === 'dose' && e.key === record.key)) {
      return false;
    }
  }
  fs.appendFileSync(ledgerFile, JSON.stringify(record) + '\n');
  return true;
}

function summarizeLedger(ledgerFile) {
  const perSlot = {};
  let total = 0;
  for (const e of readLedger(ledgerFile)) {
    perSlot[e.key] = (perSlot[e.key] || 0) + e.dose;
    total += e.dose;
  }
  return { total, per_slot: perSlot };
}

// ---------------------------------------------------------------------------
// Crash injection (test hook): DOSE_CRASH_AFTER=intent|effect, DOSE_CRASH_SEQ=n
// ---------------------------------------------------------------------------
function maybeCrash(crash, point, seq) {
  if (crash && crash.after === point && crash.seq === seq) {
    process.kill(process.pid, 'SIGKILL');
  }
}

// One dosing step: intent -> effect -> checkpoint.
function runStep(journalDir, ledgerFile, dose, seq, crash) {
  const key = doseKey(dose.pump_id, dose.slot);
  appendJournal(journalDir, {
    type: 'intent',
    seq,
    key,
    pump_id: dose.pump_id,
    slot: dose.slot,
    dose: dose.dose,
  });
  maybeCrash(crash, 'intent', seq);
  appendJournal(journalDir, { type: 'effect', seq, key });
  appendLedger(ledgerFile, {
    key,
    kind: 'dose',
    pump_id: dose.pump_id,
    slot: dose.slot,
    dose: dose.dose,
    seq,
  });
  maybeCrash(crash, 'effect', seq);
  appendJournal(journalDir, { type: 'checkpoint', seq });
}

// ---------------------------------------------------------------------------
// exec: run a full plan from scratch.
// ---------------------------------------------------------------------------
function execPlan({ planPath, pumpsPath, journalDir, outDir, crash = null }) {
  const plan = loadJson(planPath);
  const pumps = loadJson(pumpsPath);
  validatePlan(plan, pumps);

  if (fs.existsSync(journalPath(journalDir))) {
    throw new Error(
      `journal is not empty: ${journalDir} (use "recover" to continue an interrupted run)`,
    );
  }
  fs.mkdirSync(journalDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  writeJson(path.join(journalDir, PLAN_SNAPSHOT), plan);
  writeJson(path.join(journalDir, PUMPS_SNAPSHOT), pumps);
  writeJson(path.join(journalDir, META_FILE), {
    out: path.resolve(outDir),
    plan: path.resolve(planPath),
    pumps: path.resolve(pumpsPath),
  });

  const ledgerFile = path.join(outDir, LEDGER_FILE);
  const executed = [];
  plan.doses.forEach((dose, seq) => {
    runStep(journalDir, ledgerFile, dose, seq, crash);
    executed.push(seq);
  });

  const summary = { executed, ...summarizeLedger(ledgerFile) };
  return summary;
}

// ---------------------------------------------------------------------------
// recover: finish an interrupted run.
//   - intent without effect   -> crash point A: replay the step
//   - effect without checkpoint -> crash point B: only append the checkpoint
// Then execute any steps that never started. Idempotent.
// ---------------------------------------------------------------------------
function recover({ journalDir, crash = null }) {
  const plan = loadJson(path.join(journalDir, PLAN_SNAPSHOT));
  const meta = loadJson(path.join(journalDir, META_FILE));
  const ledgerFile = path.join(meta.out, LEDGER_FILE);

  const state = new Map(); // seq -> {intent, effect, checkpoint}
  for (const e of readJournal(journalDir)) {
    const s = state.get(e.seq) || { intent: false, effect: false, checkpoint: false };
    if (e.type === 'intent') s.intent = true;
    if (e.type === 'effect') s.effect = true;
    if (e.type === 'checkpoint') s.checkpoint = true;
    state.set(e.seq, s);
  }

  const replayed = [];
  const checkpointOnly = [];
  const executed = [];

  plan.doses.forEach((dose, seq) => {
    const s = state.get(seq);
    if (s && s.checkpoint) return; // already completed
    if (s && s.effect) {
      // Crash point B: effect was written, checkpoint was not. The ledger
      // write is idempotent, so ensuring it here can never double-dose.
      appendLedger(ledgerFile, {
        key: doseKey(dose.pump_id, dose.slot),
        kind: 'dose',
        pump_id: dose.pump_id,
        slot: dose.slot,
        dose: dose.dose,
        seq,
      });
      appendJournal(journalDir, { type: 'checkpoint', seq });
      checkpointOnly.push(seq);
      return;
    }
    if (s && s.intent) {
      // Crash point A: intent written, effect missing -> replay the step.
      runStep(journalDir, ledgerFile, dose, seq, crash);
      replayed.push(seq);
      return;
    }
    runStep(journalDir, ledgerFile, dose, seq, crash);
    executed.push(seq);
  });

  const result = {
    recovered: true,
    replayed,
    checkpoint_only: checkpointOnly,
    executed,
    ...summarizeLedger(ledgerFile),
  };
  writeJson(path.join(journalDir, RECOVERED_FILE), result);
  return result;
}

// ---------------------------------------------------------------------------
// modifyPlan: corrections may only touch unlocked slots. Slots that already
// have a dose in the ledger are locked; changes/removals targeting them are
// rejected (and listed) and a negative "compensate" record is written to the
// ledger instead of deleting history.
// ---------------------------------------------------------------------------
function modifyPlan({ journalDir, newPlanPath }) {
  const current = loadJson(path.join(journalDir, PLAN_SNAPSHOT));
  const pumps = loadJson(path.join(journalDir, PUMPS_SNAPSHOT));
  const meta = loadJson(path.join(journalDir, META_FILE));
  const next = loadJson(newPlanPath);
  validatePlan(next, pumps); // unknown pump / negative dose / overlap -> exit 2

  const ledgerFile = path.join(meta.out, LEDGER_FILE);
  const locked = new Map(); // key -> recorded net dose
  for (const e of readLedger(ledgerFile)) {
    locked.set(e.key, (locked.get(e.key) || 0) + e.dose);
  }

  const applied = [];
  const rejected = [];
  const compensations = [];
  const nextKeys = new Set(next.doses.map((d) => doseKey(d.pump_id, d.slot)));

  // Entries present in the new plan.
  for (const d of next.doses) {
    const key = doseKey(d.pump_id, d.slot);
    if (locked.has(key)) {
      const recorded = locked.get(key);
      if (d.dose === recorded) {
        applied.push({ pump_id: d.pump_id, slot: d.slot, change: 'unchanged' });
        continue;
      }
      rejected.push({
        pump_id: d.pump_id,
        slot: d.slot,
        reason: 'slot locked (already dosed); plan modification refused',
        requested_dose: d.dose,
        recorded_dose: recorded,
      });
      if (d.dose < recorded) {
        compensations.push(
          appendCompensation(ledgerFile, d.pump_id, d.slot, d.dose - recorded, 'modify_plan reduce'),
        );
      }
      continue;
    }
    applied.push({ pump_id: d.pump_id, slot: d.slot, change: 'set', dose: d.dose });
  }

  // Entries removed by the new plan.
  for (const d of current.doses) {
    const key = doseKey(d.pump_id, d.slot);
    if (nextKeys.has(key)) continue;
    if (locked.has(key)) {
      rejected.push({
        pump_id: d.pump_id,
        slot: d.slot,
        reason: 'slot locked (already dosed); deletion refused, compensated instead',
        recorded_dose: locked.get(key),
      });
      compensations.push(
        appendCompensation(ledgerFile, d.pump_id, d.slot, -locked.get(key), 'modify_plan cancel'),
      );
      continue;
    }
    applied.push({ pump_id: d.pump_id, slot: d.slot, change: 'removed' });
  }

  // Persist the corrected plan: locked slots stay as recorded, everything
  // else follows the new plan.
  const updated = { ...current, doses: [] };
  for (const d of current.doses) {
    const key = doseKey(d.pump_id, d.slot);
    if (locked.has(key)) updated.doses.push(d);
  }
  for (const d of next.doses) {
    const key = doseKey(d.pump_id, d.slot);
    if (!locked.has(key)) updated.doses.push(d);
  }
  updated.doses.sort((a, b) => a.slot - b.slot || a.pump_id.localeCompare(b.pump_id));
  writeJson(path.join(journalDir, PLAN_SNAPSHOT), updated);

  const result = { applied, rejected, compensations };
  writeJson(path.join(journalDir, MODIFY_RESULT_FILE), result);
  return result;
}

function appendCompensation(ledgerFile, pumpId, slot, dose, reason) {
  const record = {
    key: doseKey(pumpId, slot),
    kind: 'compensate',
    pump_id: pumpId,
    slot,
    dose,
    reason,
  };
  appendLedger(ledgerFile, record);
  return record;
}

// ---------------------------------------------------------------------------
// compensate: explicitly cancel (part of) an already-dosed slot with a
// negative ledger record. History is never deleted.
// ---------------------------------------------------------------------------
function compensate({ journalDir, pumpId, slot, dose = null }) {
  const meta = loadJson(path.join(journalDir, META_FILE));
  const ledgerFile = path.join(meta.out, LEDGER_FILE);
  const key = doseKey(pumpId, slot);
  const net = readLedger(ledgerFile)
    .filter((e) => e.key === key)
    .reduce((acc, e) => acc + e.dose, 0);
  if (net === 0 && dose === null) {
    throw new Error(`nothing to compensate for ${key}`);
  }
  const amount = dose === null ? -net : dose;
  if (typeof amount !== 'number' || Number.isNaN(amount) || amount >= 0) {
    throw new PlanError(`compensation dose must be negative, got ${String(amount)}`);
  }
  const record = appendCompensation(ledgerFile, pumpId, slot, amount, 'manual compensate');
  return { compensated: record, ...summarizeLedger(ledgerFile) };
}

module.exports = {
  PlanError,
  LEDGER_FILE,
  doseKey,
  validatePlan,
  readJournal,
  readLedger,
  appendLedger,
  summarizeLedger,
  execPlan,
  recover,
  modifyPlan,
  compensate,
};
