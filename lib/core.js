'use strict';

const fs = require('fs');
const path = require('path');

class PlanError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PlanError';
    this.code = code; // UNKNOWN_PUMP | NEGATIVE_DOSE | SLOT_OVERLAP
  }
}

// ---------- low-level durable writes ----------

function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function appendJsonlSync(file, obj) {
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(obj) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

// ---------- normalization & validation ----------

function normalizePumps(raw) {
  const list = Array.isArray(raw) ? raw : raw.pumps;
  if (!Array.isArray(list)) throw new PlanError('UNKNOWN_PUMP', 'pumps.json has no pump list');
  return new Set(list.map((p) => (typeof p === 'string' ? p : p.pump_id)));
}

function normalizeDoses(raw) {
  const list = Array.isArray(raw) ? raw : raw.doses;
  if (!Array.isArray(list)) throw new PlanError('SLOT_OVERLAP', 'plan has no doses list');
  return list;
}

function slotLabel(slot) {
  return typeof slot === 'object' && slot !== null ? JSON.stringify(slot) : String(slot);
}

function keyOf(dose) {
  return `${dose.pump_id}::${slotLabel(dose.slot)}`;
}

function keyToFile(key) {
  return encodeURIComponent(key);
}

function validatePlan(doses, pumpIds) {
  for (const d of doses) {
    if (!pumpIds.has(d.pump_id)) {
      throw new PlanError('UNKNOWN_PUMP', `unknown pump: ${d.pump_id}`);
    }
    if (typeof d.dose !== 'number' || !(d.dose >= 0)) {
      throw new PlanError('NEGATIVE_DOSE', `negative dose for ${d.pump_id} slot ${slotLabel(d.slot)}`);
    }
  }
  // slot overlap per pump: identical slot labels, or overlapping [start,end) intervals
  const byPump = new Map();
  for (const d of doses) {
    if (!byPump.has(d.pump_id)) byPump.set(d.pump_id, []);
    byPump.get(d.pump_id).push(d);
  }
  for (const [pump, list] of byPump) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].slot;
        const b = list[j].slot;
        const overlap =
          slotLabel(a) === slotLabel(b) ||
          (isInterval(a) && isInterval(b) && a.start < b.end && b.start < a.end);
        if (overlap) {
          throw new PlanError(
            'SLOT_OVERLAP',
            `slot overlap on pump ${pump}: ${slotLabel(a)} vs ${slotLabel(b)}`
          );
        }
      }
    }
  }
}

function isInterval(slot) {
  return (
    typeof slot === 'object' &&
    slot !== null &&
    typeof slot.start === 'number' &&
    typeof slot.end === 'number'
  );
}

// ---------- journal layout ----------

function journalPaths(journalDir) {
  return {
    dir: journalDir,
    intents: path.join(journalDir, 'intents'),
    effects: path.join(journalDir, 'effects'),
    checkpoints: path.join(journalDir, 'checkpoints'),
    ledger: path.join(journalDir, 'dose_ledger.jsonl'),
    plan: path.join(journalDir, 'plan.json'),
    pumps: path.join(journalDir, 'pumps.json'),
    recovered: path.join(journalDir, 'recovered.json'),
  };
}

function ensureJournal(journalDir) {
  const p = journalPaths(journalDir);
  fs.mkdirSync(p.intents, { recursive: true });
  fs.mkdirSync(p.effects, { recursive: true });
  fs.mkdirSync(p.checkpoints, { recursive: true });
  return p;
}

// ---------- crash injection (for acceptance tests) ----------
// DOSE_CRASH_AT = "<stepIndex>:<intent|effect>" -> SIGKILL after that write.

function maybeCrash(stepIndex, point) {
  const spec = process.env.DOSE_CRASH_AT;
  if (!spec) return;
  const [idx, at] = spec.split(':');
  if (Number(idx) === stepIndex && at === point) {
    process.kill(process.pid, 'SIGKILL');
  }
}

// ---------- exec ----------

function execPlan({ planPath, pumpsPath, journalDir, outDir }) {
  const planRaw = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const pumpsFile = pumpsPath || path.join(path.dirname(planPath), 'pumps.json');
  const pumpsRaw = JSON.parse(fs.readFileSync(pumpsFile, 'utf8'));
  const pumpIds = normalizePumps(pumpsRaw);
  const doses = normalizeDoses(planRaw);
  validatePlan(doses, pumpIds);

  const jp = ensureJournal(journalDir);
  writeJsonAtomic(jp.plan, { doses });
  writeJsonAtomic(jp.pumps, { pumps: [...pumpIds] });

  doses.forEach((dose, stepIndex) => {
    const key = keyOf(dose);
    const f = keyToFile(key);
    if (fs.existsSync(path.join(jp.checkpoints, f + '.json'))) return; // already done

    // 1. intent
    writeJsonAtomic(path.join(jp.intents, f + '.json'), {
      type: 'intent', key, step: stepIndex, pump_id: dose.pump_id, slot: dose.slot, dose: dose.dose,
    });
    maybeCrash(stepIndex, 'intent');

    // 2. effect: idempotent append keyed by pump_id+slot
    const ledgerSoFar = readJsonl(jp.ledger);
    const ledgerKeys = new Set(ledgerSoFar.map((e) => e.key));
    if (!ledgerKeys.has(key)) {
      appendJsonlSync(jp.ledger, {
        seq: ledgerSoFar.length,
        key, type: 'dose', pump_id: dose.pump_id, slot: dose.slot, dose: dose.dose,
      });
    }
    writeJsonAtomic(path.join(jp.effects, f + '.json'), { type: 'effect', key, step: stepIndex });
    maybeCrash(stepIndex, 'effect');

    // 3. checkpoint
    writeJsonAtomic(path.join(jp.checkpoints, f + '.json'), { type: 'checkpoint', key, step: stepIndex });
  });

  const ledger = readJsonl(jp.ledger);
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, 'dose_ledger.jsonl'),
      ledger.map((e) => JSON.stringify(e)).join('\n') + (ledger.length ? '\n' : '')
    );
  }
  return { ledger, totalDose: ledger.reduce((s, e) => s + e.dose, 0) };
}

// ---------- recover ----------

function recover({ journalDir }) {
  const jp = ensureJournal(journalDir);
  const intents = fs.existsSync(jp.intents) ? fs.readdirSync(jp.intents).sort() : [];
  const replayed = [];
  const checkpointOnly = [];

  for (const file of intents) {
    const intent = JSON.parse(fs.readFileSync(path.join(jp.intents, file), 'utf8'));
    const f = keyToFile(intent.key);
    const effectFile = path.join(jp.effects, f + '.json');
    const checkpointFile = path.join(jp.checkpoints, f + '.json');

    if (!fs.existsSync(effectFile)) {
      // fault class 1: intent written, effect missing -> replay the step
      const ledgerSoFar = readJsonl(jp.ledger);
      const ledgerKeys = new Set(ledgerSoFar.map((e) => e.key));
      if (!ledgerKeys.has(intent.key)) {
        appendJsonlSync(jp.ledger, {
          seq: ledgerSoFar.length,
          key: intent.key, type: 'dose', pump_id: intent.pump_id, slot: intent.slot, dose: intent.dose,
        });
      }
      writeJsonAtomic(effectFile, { type: 'effect', key: intent.key, step: intent.step, replayed: true });
      writeJsonAtomic(checkpointFile, { type: 'checkpoint', key: intent.key, step: intent.step });
      replayed.push(intent.key);
    } else if (!fs.existsSync(checkpointFile)) {
      // fault class 2: effect written, checkpoint missing -> only complete checkpoint
      writeJsonAtomic(checkpointFile, { type: 'checkpoint', key: intent.key, step: intent.step });
      checkpointOnly.push(intent.key);
    }
  }

  const ledger = readJsonl(jp.ledger);
  const result = {
    replayed,
    checkpoint_completed: checkpointOnly,
    ledger_entries: ledger.length,
    total_dose: ledger.reduce((s, e) => s + e.dose, 0),
  };
  writeJsonAtomic(jp.recovered, result);
  return result;
}

// ---------- modify_plan ----------

function lockedKeys(jp) {
  const locked = new Set(readJsonl(jp.ledger).map((e) => e.key));
  if (fs.existsSync(jp.checkpoints)) {
    for (const file of fs.readdirSync(jp.checkpoints)) {
      const cp = JSON.parse(fs.readFileSync(path.join(jp.checkpoints, file), 'utf8'));
      locked.add(cp.key);
    }
  }
  return locked;
}

function modifyPlan({ journalDir, newPlanPath }) {
  const jp = ensureJournal(journalDir);
  const current = JSON.parse(fs.readFileSync(jp.plan, 'utf8'));
  const pumpsRaw = JSON.parse(fs.readFileSync(jp.pumps, 'utf8'));
  const pumpIds = normalizePumps(pumpsRaw);
  const newDoses = normalizeDoses(JSON.parse(fs.readFileSync(newPlanPath, 'utf8')));
  validatePlan(newDoses, pumpIds);

  const locked = lockedKeys(jp);
  const currentByKey = new Map(current.doses.map((d) => [keyOf(d), d]));
  const newByKey = new Map(newDoses.map((d) => [keyOf(d), d]));
  const applied = [];
  const rejected = [];

  // removals
  for (const [key, d] of currentByKey) {
    if (!newByKey.has(key)) {
      if (locked.has(key)) {
        rejected.push({ pump_id: d.pump_id, slot: d.slot, reason: 'slot_locked_already_dosed' });
      } else {
        applied.push({ op: 'remove', pump_id: d.pump_id, slot: d.slot });
        currentByKey.delete(key);
      }
    }
  }
  // additions & changes
  for (const [key, d] of newByKey) {
    const prev = currentByKey.get(key);
    if (prev && prev.dose === d.dose) continue;
    if (locked.has(key)) {
      rejected.push({ pump_id: d.pump_id, slot: d.slot, reason: 'slot_locked_already_dosed' });
    } else {
      applied.push({ op: prev ? 'change' : 'add', pump_id: d.pump_id, slot: d.slot, dose: d.dose });
      currentByKey.set(key, d);
    }
  }

  const updated = { doses: [...currentByKey.values()] };
  writeJsonAtomic(jp.plan, updated);
  const result = { applied, rejected, plan: updated };
  writeJsonAtomic(path.join(journalDir, 'modify_plan_result.json'), result);
  return result;
}

// ---------- compensate ----------

function compensate({ journalDir, pumpId, slot, dose }) {
  const jp = ensureJournal(journalDir);
  if (typeof dose !== 'number' || !(dose >= 0)) {
    throw new PlanError('NEGATIVE_DOSE', `compensate dose must be >= 0, got ${dose}`);
  }
  const ledger = readJsonl(jp.ledger);
  const baseKey = `${pumpId}::${slotLabel(slot)}`;
  const seq = ledger.filter((e) => e.type === 'compensate' && e.base_key === baseKey).length + 1;
  const entry = {
    seq: ledger.length,
    key: `${baseKey}::compensate::${seq}`,
    base_key: baseKey,
    type: 'compensate',
    pump_id: pumpId,
    slot,
    dose: -dose,
  };
  appendJsonlSync(jp.ledger, entry);
  return entry;
}

module.exports = {
  PlanError,
  execPlan,
  recover,
  modifyPlan,
  compensate,
  readJsonl,
  journalPaths,
  keyOf,
  validatePlan,
  normalizePumps,
  normalizeDoses,
};
