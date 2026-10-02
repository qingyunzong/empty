import fs from 'node:fs';
import path from 'node:path';
import { EngineError, CrashError } from './errors.js';
import { readJournal, truncateTornTail, ensureTrailingNewline } from './journal.js';
import { buildDag } from './protocol.js';

// Fixed fault-injection points: before/after the effect record hits disk, and
// in the middle of the checkpoint record write.
export const CRASH_POINTS = ['before-effect', 'after-effect', 'during-checkpoint'];

class JournalWriter {
  constructor(journalPath, seq = 0) {
    this.path = journalPath;
    this.seq = seq;
  }
  append(rec) {
    const full = { v: 1, seq: ++this.seq, ...rec };
    fs.appendFileSync(this.path, JSON.stringify(full) + '\n');
    return full;
  }
  appendPartial(str) {
    fs.appendFileSync(this.path, str);
  }
}

function analyze(records) {
  const steps = new Map();
  const get = (id) => {
    if (!steps.has(id)) steps.set(id, {});
    return steps.get(id);
  };
  let runStart = null;
  let runEnd = null;
  const compensations = [];
  for (const r of records) {
    switch (r.type) {
      case 'run_start': runStart = r; break;
      case 'run_end': runEnd = r; break;
      case 'intent': get(r.step).intent = r; break;
      case 'effect': get(r.step).effect = r; break;
      case 'checkpoint': get(r.step).checkpoint = r; break;
      case 'abort': get(r.step).abort = r; break;
      case 'compensate':
        compensations.push(r);
        if (r.action === 'discard') get(r.step).discarded = r;
        if (r.action === 'release') get(r.step).released = r;
        break;
      default: break;
    }
  }
  return { runStart, runEnd, steps, compensations };
}

const getSt = (ctx, id) => {
  if (!ctx.analysis.steps.has(id)) ctx.analysis.steps.set(id, {});
  return ctx.analysis.steps.get(id);
};

const artifactFile = (stateDir, a) => path.join(stateDir, encodeURIComponent(a) + '.json');

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function makeCtx(dag, jw, opts, analysis) {
  const ctx = {
    dag,
    jw,
    analysis,
    stateDir: opts.stateDir,
    now: opts.now ?? Date.now(),
    crashAt: opts.crashAt ?? null,
    abortAt: opts.abortAt ?? null,
    actions: [],
    compensations: [...analysis.compensations],
    orphansRemoved: [],
    tornLineTruncated: false,
    visible: new Set(),
  };
  for (const [, st] of analysis.steps) {
    if (st.effect) for (const p of st.effect.produced ?? []) ctx.visible.add(p);
  }
  return ctx;
}

function validateInjectionPoints(dag, opts) {
  if (opts.crashAt) {
    const [sid, point] = opts.crashAt.split(':');
    if (!CRASH_POINTS.includes(point) || !dag.byId.has(sid)) {
      throw new EngineError(
        'USAGE',
        `invalid --crash-at "${opts.crashAt}"; expected <step>:<${CRASH_POINTS.join('|')}>`,
      );
    }
  }
  if (opts.abortAt && !dag.byId.has(opts.abortAt)) {
    throw new EngineError('USAGE', `unknown --abort-at step "${opts.abortAt}"`);
  }
}

export function runProtocol(opts) {
  const { journalPath } = opts;
  if (fs.existsSync(journalPath) && fs.statSync(journalPath).size > 0) {
    throw new EngineError('JOURNAL_EXISTS', `journal ${journalPath} is not empty; use "recover"`);
  }
  let proto;
  try {
    proto = JSON.parse(fs.readFileSync(opts.protocolPath, 'utf8'));
  } catch (e) {
    throw new EngineError('PROTOCOL_INVALID', `cannot read protocol: ${e.message}`);
  }
  const dag = buildDag(proto);
  validateInjectionPoints(dag, opts);
  fs.mkdirSync(path.dirname(journalPath), { recursive: true });
  fs.mkdirSync(opts.stateDir, { recursive: true });
  const jw = new JournalWriter(journalPath);
  jw.append({ type: 'run_start', runId: opts.runId ?? 'run', protocol: proto, ts: opts.now ?? Date.now() });
  const ctx = makeCtx(dag, jw, opts, analyze([]));
  const outcome = execute(ctx);
  writeJson(opts.resultPath, buildResult(dag, ctx, outcome));
  return outcome;
}

export function recoverProtocol(opts) {
  const { journalPath } = opts;
  if (!fs.existsSync(journalPath) || fs.statSync(journalPath).size === 0) {
    throw new EngineError('JOURNAL_MISSING', `journal ${journalPath} not found or empty`);
  }
  const { records, torn, maxSeq } = readJournal(journalPath);
  if (torn) truncateTornTail(journalPath);
  else ensureTrailingNewline(journalPath);
  const analysis = analyze(records);
  if (!analysis.runStart) throw new EngineError('JOURNAL_CORRUPT', 'journal has no run_start record');
  const dag = buildDag(analysis.runStart.protocol);
  validateInjectionPoints(dag, opts);
  fs.mkdirSync(opts.stateDir, { recursive: true });
  const jw = new JournalWriter(journalPath, maxSeq);
  const ctx = makeCtx(dag, jw, opts, analysis);
  ctx.tornLineTruncated = torn;
  let outcome;
  try {
    outcome = execute(ctx);
  } catch (e) {
    if (e instanceof EngineError) {
      const failed = { status: 'failed', error: e };
      writeJson(opts.resultPath, buildResult(dag, ctx, failed));
      writeJson(opts.reportPath, buildReport(ctx, failed));
    }
    throw e;
  }
  writeJson(opts.resultPath, buildResult(dag, ctx, outcome));
  writeJson(opts.reportPath, buildReport(ctx, outcome));
  return outcome;
}

function execute(ctx) {
  const { dag, analysis } = ctx;

  if (analysis.runEnd) {
    if (ctx.abortAt) {
      const st = getSt(ctx, ctx.abortAt);
      if (st.checkpoint && dag.joins.has(ctx.abortAt)) {
        throw new EngineError('ABORT_COMPLETED_JOIN', `cannot abort join "${ctx.abortAt}": already completed`);
      }
      throw new EngineError('RUN_FINISHED', 'run already finished; nothing to abort');
    }
    return { status: analysis.runEnd.status, alreadyFinished: true, compensations: ctx.compensations };
  }

  // Half-done steps (intent without effect): timeout decides continue vs discard.
  const discarded = new Set();
  for (const step of dag.steps) {
    const st = getSt(ctx, step.id);
    if (st.intent && !st.effect && !st.discarded && step.timeout != null && ctx.now - st.intent.ts > step.timeout) {
      discarded.add(step.id);
    }
  }

  validateCommittedEffects(ctx, discarded);

  if (discarded.size > 0) return abortRun(ctx, { discarded, reason: 'timeout' });

  reconcileStateDir(ctx);

  // Layers run in dependency order; steps inside a layer are independent and
  // execute as a parallel batch (no ordering constraints between them).
  for (const layer of dag.layers) {
    for (const stepId of layer) {
      const step = dag.byId.get(stepId);
      const st = getSt(ctx, stepId);
      if (ctx.abortAt === stepId) {
        if (st.checkpoint) {
          throw new EngineError(
            dag.joins.has(stepId) ? 'ABORT_COMPLETED_JOIN' : 'ABORT_COMPLETED_STEP',
            `cannot abort "${stepId}": already completed`,
          );
        }
        return abortRun(ctx, { trigger: stepId, reason: 'requested', discarded });
      }
      if (st.checkpoint || st.discarded || st.released) continue;
      checkRequires(ctx, step);
      executeStep(ctx, step, st);
    }
  }

  ctx.jw.append({ type: 'run_end', status: 'completed', ts: ctx.now });
  return { status: 'completed', compensations: ctx.compensations };
}

function executeStep(ctx, step, st) {
  const { jw } = ctx;
  if (st.effect) {
    // Effect committed before the crash: never repeat it, only finish the checkpoint.
    appendCheckpoint(ctx, step, st);
    ctx.actions.push({ step: step.id, action: 'complete_checkpoint' });
    return;
  }
  if (!st.intent) {
    st.intent = jw.append({ type: 'intent', step: step.id, requires: step.requires, produces: step.produces, ts: ctx.now });
  } else {
    ctx.actions.push({ step: step.id, action: 'reexecute' });
  }
  for (const p of step.produces) {
    writeJson(artifactFile(ctx.stateDir, p), {
      artifact: p, producedBy: step.id, op: step.op, inputs: step.requires, at: ctx.now,
    });
  }
  maybeCrash(ctx, step.id, 'before-effect');
  st.effect = jw.append({ type: 'effect', step: step.id, consumed: step.requires, produced: step.produces, ts: ctx.now });
  for (const p of step.produces) ctx.visible.add(p);
  maybeCrash(ctx, step.id, 'after-effect');
  appendCheckpoint(ctx, step, st);
}

function appendCheckpoint(ctx, step, st) {
  if (ctx.crashAt === `${step.id}:during-checkpoint`) {
    const rec = { v: 1, seq: ctx.jw.seq + 1, type: 'checkpoint', step: step.id, status: 'done', ts: ctx.now };
    const s = JSON.stringify(rec);
    ctx.jw.appendPartial(s.slice(0, Math.max(1, Math.floor(s.length / 2))));
    throw new CrashError(`simulated power loss during checkpoint write of "${step.id}"`);
  }
  st.checkpoint = ctx.jw.append({ type: 'checkpoint', step: step.id, status: 'done', ts: ctx.now });
}

function maybeCrash(ctx, stepId, point) {
  if (ctx.crashAt === `${stepId}:${point}`) {
    throw new CrashError(`simulated power loss at ${stepId}:${point}`);
  }
}

function checkRequires(ctx, step) {
  for (const r of step.requires) {
    const prod = ctx.dag.producerOf.get(r);
    if (prod && !ctx.visible.has(r)) {
      throw new EngineError('MISSING_PRODUCT', `step "${step.id}" requires "${r}" but no committed effect from "${prod}" is visible`);
    }
  }
}

// A committed effect/checkpoint must only exist when all upstream effects were
// visible; otherwise the journal itself is inconsistent.
function validateCommittedEffects(ctx, discarded) {
  const { dag } = ctx;
  for (const step of dag.steps) {
    const st = getSt(ctx, step.id);
    if (!st.effect) continue;
    for (const r of step.requires) {
      const prod = dag.producerOf.get(r);
      if (!prod) continue;
      const pst = getSt(ctx, prod);
      if (discarded.has(prod) || pst.discarded) {
        throw new EngineError(
          dag.joins.has(step.id) ? 'TIMEOUT_JOIN' : 'STALE_EFFECT',
          `step "${step.id}" committed although upstream "${prod}" was discarded after timeout`,
        );
      }
      if (!pst.effect) {
        throw new EngineError('MISSING_PRODUCT', `step "${step.id}" committed but product "${r}" from "${prod}" is missing`);
      }
    }
  }
}

function reconcileStateDir(ctx) {
  for (const f of fs.readdirSync(ctx.stateDir)) {
    if (!f.endsWith('.json')) continue;
    const artifact = decodeURIComponent(f.slice(0, -'.json'.length));
    if (!ctx.visible.has(artifact)) {
      fs.unlinkSync(path.join(ctx.stateDir, f));
      ctx.orphansRemoved.push(artifact);
    }
  }
  for (const [, st] of ctx.analysis.steps) {
    if (!st.effect) continue;
    for (const p of st.effect.produced ?? []) {
      if (!fs.existsSync(artifactFile(ctx.stateDir, p))) {
        throw new EngineError('MISSING_PRODUCT', `product "${p}" committed in journal but missing from state dir`);
      }
    }
  }
}

// Compensation chain, saga-style in reverse topological order:
//  - discarded half-done step: discard its partial product, mark its inputs consumed
//  - completed steps: consumed samples cannot be recovered, only marked consumed;
//    products nobody consumed become discarded waste
//  - never-started steps: release their reservations
function planCompensation(ctx, discarded) {
  const { dag } = ctx;
  const comps = [];
  const consumedSomewhere = new Set();
  for (const s of dag.steps) {
    const st = getSt(ctx, s.id);
    if (st.checkpoint || st.effect || discarded.has(s.id)) {
      for (const r of s.requires) consumedSomewhere.add(r);
    }
  }
  const markedConsumed = new Set();
  const reverseTopo = [...dag.layers].reverse().flat();
  for (const id of reverseTopo) {
    const step = dag.byId.get(id);
    const st = getSt(ctx, id);
    if (discarded.has(id)) {
      comps.push({ step: id, action: 'discard', reason: 'timeout', artifacts: [...step.produces] });
      const consumed = step.requires.filter((r) => !markedConsumed.has(r));
      if (consumed.length > 0) {
        comps.push({ step: id, action: 'mark_consumed', artifacts: consumed });
        consumed.forEach((a) => markedConsumed.add(a));
      }
    } else if (st.checkpoint || st.effect) {
      const consumed = step.requires.filter((r) => !markedConsumed.has(r));
      if (consumed.length > 0) {
        comps.push({ step: id, action: 'mark_consumed', artifacts: consumed });
        consumed.forEach((a) => markedConsumed.add(a));
      }
      const waste = step.produces.filter((p) => !consumedSomewhere.has(p));
      if (waste.length > 0) comps.push({ step: id, action: 'discard', reason: 'waste', artifacts: waste });
    } else {
      comps.push({ step: id, action: 'release', artifacts: [] });
    }
  }
  return comps;
}

function abortRun(ctx, { trigger = null, reason, discarded }) {
  const { jw } = ctx;
  if (trigger) jw.append({ type: 'abort', step: trigger, reason, ts: ctx.now });
  for (const id of discarded) jw.append({ type: 'abort', step: id, reason: 'timeout', ts: ctx.now });
  for (const c of planCompensation(ctx, discarded)) {
    jw.append({ type: 'compensate', ...c, ts: ctx.now });
    ctx.compensations.push(c);
    const st = getSt(ctx, c.step);
    if (c.action === 'discard') {
      st.discarded = c;
      ctx.actions.push({ step: c.step, action: 'discard', reason: c.reason });
      for (const a of c.artifacts) {
        const f = artifactFile(ctx.stateDir, a);
        if (fs.existsSync(f)) fs.unlinkSync(f);
        ctx.visible.delete(a);
      }
    }
    if (c.action === 'release') st.released = c;
  }
  jw.append({ type: 'run_end', status: 'aborted', ts: ctx.now });
  return { status: 'aborted', reason, compensations: ctx.compensations };
}

function stepStatus(st) {
  if (st.checkpoint) return 'done';
  if (st.discarded) return 'discarded';
  if (st.released) return 'released';
  if (st.effect) return 'effect_committed';
  if (st.intent) return 'in_progress';
  return 'pending';
}

const compView = (c) => ({
  step: c.step,
  action: c.action,
  artifacts: c.artifacts ?? [],
  ...(c.reason ? { reason: c.reason } : {}),
});

function buildResult(dag, ctx, outcome) {
  const steps = dag.steps.map((s) => ({
    id: s.id,
    op: s.op,
    status: stepStatus(getSt(ctx, s.id)),
    requires: s.requires,
    produces: s.produces,
  }));
  const consumed = [...new Set(
    dag.steps.filter((s) => getSt(ctx, s.id).checkpoint).flatMap((s) => s.requires),
  )];
  const discardedArts = ctx.compensations.filter((c) => c.action === 'discard').flatMap((c) => c.artifacts ?? []);
  const result = {
    status: outcome.status,
    protocol: dag.proto.name ?? null,
    steps,
    artifacts: {
      produced: [...ctx.visible],
      consumed,
      discarded: [...new Set(discardedArts)],
    },
    compensations: ctx.compensations.map(compView),
  };
  if (outcome.error) result.error = { code: outcome.error.code, message: outcome.error.message };
  return result;
}

function buildReport(ctx, outcome) {
  const report = {
    status: outcome.status,
    tornLineTruncated: ctx.tornLineTruncated,
    orphansRemoved: ctx.orphansRemoved,
    actions: ctx.actions,
    compensations: ctx.compensations.map(compView),
  };
  if (outcome.error) report.errors = [{ code: outcome.error.code, message: outcome.error.message }];
  return report;
}
