'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJournal, appendRecord, appendRaw, truncateJournal } = require('./journal');

const CRASH_EXIT_CODE = 75; // injected crash (simulated power loss)

class EngineError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

class Engine {
  constructor({ protocol, journalPath, stateDir, now, crashAt = null, abortStep = null }) {
    this.protocol = protocol;
    this.journalPath = journalPath;
    this.stateDir = stateDir;
    this.now = now == null ? Date.now() : now;
    this.crashAt = crashAt; // { point: 'before-effect'|'after-effect'|'during-checkpoint', step }
    this.abortStep = abortStep;
    fs.mkdirSync(this.stateDir, { recursive: true });
  }

  append(fields) {
    const rec = Object.assign({ v: 1, ts: this.now }, fields);
    appendRecord(this.journalPath, rec);
    return rec;
  }

  derive(records) {
    const steps = {};
    for (const s of this.protocol.steps) {
      steps[s.id] = {
        id: s.id,
        status: 'pending',
        attempt: 0,
        intentTs: null,
        effect: null,
        checkpoint: null,
        discard: null,
        abort: null,
      };
    }
    const compensations = [];
    for (const r of records) {
      const st = steps[r.step];
      switch (r.type) {
        case 'intent':
          st.attempt = r.attempt;
          st.intentTs = r.ts;
          st.status = 'in_flight';
          break;
        case 'effect':
          st.effect = r;
          st.status = 'effected';
          break;
        case 'checkpoint':
          st.checkpoint = r;
          if (r.status === 'done') st.status = 'done';
          break;
        case 'abort':
          st.abort = r;
          st.status = 'aborted';
          break;
        case 'discard':
          st.discard = r;
          st.status = 'discarded';
          break;
        case 'compensation':
          compensations.push(r);
          break;
        default:
          break;
      }
    }
    for (const c of compensations) {
      if (c.action === 'release' && steps[c.step] && steps[c.step].status === 'pending') {
        steps[c.step].status = 'released';
      }
    }
    return { steps, compensations };
  }

  // Recovery pass: fix torn tail, repair checkpoints, decide in-flight steps
  // by timeout, then run consistency checks. Returns { report, derived }.
  recover() {
    const report = {
      journal: this.journalPath,
      recoveredAt: this.now,
      tornRecords: [],
      truncatedToBytes: null,
      repairedCheckpoints: [],
      continuedSteps: [],
      discardedSteps: [],
      effectsPreserved: [],
      compensations: [],
    };
    const loaded = readJournal(this.journalPath);
    if (loaded.torn) {
      truncateJournal(this.journalPath, loaded.validBytes);
      report.tornRecords.push(loaded.torn);
      report.truncatedToBytes = loaded.validBytes;
    }
    const derived = this.derive(loaded.records);
    for (const s of this.protocol.steps) {
      const st = derived.steps[s.id];
      if (st.status === 'effected') {
        // Effect is durable; never re-execute, only repair the checkpoint.
        this.assertProductsExist(s);
        const rec = this.append({ type: 'checkpoint', step: s.id, attempt: st.attempt, status: 'done' });
        st.status = 'done';
        st.checkpoint = rec;
        report.repairedCheckpoints.push(s.id);
        report.effectsPreserved.push(s.id);
      } else if (st.status === 'in_flight') {
        const timeoutMs = s.timeout == null ? Infinity : s.timeout * 1000;
        const elapsedMs = this.now - st.intentTs;
        if (elapsedMs > timeoutMs) {
          const rec = this.append({
            type: 'discard',
            step: s.id,
            attempt: st.attempt,
            reason: 'timeout',
            elapsedMs,
            timeoutMs,
          });
          st.status = 'discarded';
          st.discard = rec;
          report.discardedSteps.push({ step: s.id, reason: 'timeout', elapsedMs, timeoutMs });
          report.compensations.push(...this.compensate(s.id, derived, 'timeout'));
        } else {
          // Half-done step still within timeout: continue (re-run its effect).
          report.continuedSteps.push(s.id);
          st.status = 'pending';
        }
      }
    }
    this.checkConsistency(derived);
    return { report, derived };
  }

  checkConsistency(derived) {
    for (const s of this.protocol.steps) {
      const st = derived.steps[s.id];
      if (st.status !== 'done') continue;
      for (const u of this.protocol.transitiveUpstream(s.id)) {
        const ust = derived.steps[u];
        if (ust.status === 'discarded' && ust.discard && ust.discard.reason === 'timeout') {
          throw new EngineError(
            'TIMEOUT_JOINED',
            `step ${s.id} completed although upstream step ${u} was discarded (timeout)`,
            2,
          );
        }
        if (ust.status === 'aborted') {
          throw new EngineError(
            'ABORTED_JOINED',
            `step ${s.id} completed although upstream step ${u} was aborted`,
            2,
          );
        }
      }
    }
  }

  assertProductsExist(step) {
    for (const p of step.produces) {
      if (!fs.existsSync(path.join(this.stateDir, p))) {
        throw new EngineError(
          'MISSING_PRODUCT',
          `product ${p} of step ${step.id} missing from state dir`,
          2,
        );
      }
    }
  }

  requiresVisible(step, derived) {
    for (const r of step.requires) {
      const producerId = this.protocol.producers.get(r);
      const pst = derived.steps[producerId];
      if (pst.status !== 'done' && pst.status !== 'effected') return false;
      if (!fs.existsSync(path.join(this.stateDir, r))) {
        throw new EngineError(
          'MISSING_PRODUCT',
          `product ${r} required by step ${step.id} missing from state dir`,
          2,
        );
      }
    }
    return true;
  }

  // Compensation chain for an aborted/discarded step: consumed samples are
  // only marked consumed (unrecoverable); unstarted downstream is released.
  compensate(stepId, derived, cause) {
    const entries = [];
    const upstream = this.protocol.transitiveUpstream(stepId);
    for (const u of [...upstream].reverse()) {
      const st = derived.steps[u];
      if (st.status === 'done' || st.status === 'effected') {
        for (const p of this.protocol.byId.get(u).produces) {
          entries.push(
            this.append({ type: 'compensation', for: stepId, cause, action: 'mark-consumed', product: p, step: u }),
          );
          fs.writeFileSync(
            path.join(this.stateDir, `${p}.consumed`),
            JSON.stringify({ product: p, consumedBy: stepId, cause, ts: this.now }) + '\n',
          );
        }
      }
    }
    for (const d of this.protocol.transitiveDownstream(stepId)) {
      const st = derived.steps[d];
      if (st.status === 'pending') {
        entries.push(this.append({ type: 'compensation', for: stepId, cause, action: 'release', step: d }));
        st.status = 'released';
      }
    }
    return entries;
  }

  abortStepNow(stepId, derived, reason) {
    const st = derived.steps[stepId];
    if (!st) throw new EngineError('UNKNOWN_STEP', `no such step: ${stepId}`, 1);
    if (st.status === 'done') {
      const isJoin = this.protocol.byId.get(stepId).requires.length > 1;
      throw new EngineError(
        'ABORT_COMPLETED',
        `cannot abort ${stepId}: ${isJoin ? 'join ' : ''}step already completed`,
        2,
      );
    }
    if (st.status === 'aborted' || st.status === 'discarded') {
      return { abort: st.abort || st.discard, compensations: [] };
    }
    const rec = this.append({ type: 'abort', step: stepId, attempt: st.attempt, reason });
    st.status = 'aborted';
    st.abort = rec;
    const compensations = this.compensate(stepId, derived, 'abort');
    return { abort: rec, compensations };
  }

  maybeCrash(point, stepId) {
    if (this.crashAt && this.crashAt.point === point && this.crashAt.step === stepId) {
      process.exit(CRASH_EXIT_CODE);
    }
  }

  executeStep(step, st) {
    st.attempt += 1;
    this.append({ type: 'intent', step: step.id, attempt: st.attempt, requires: step.requires, produces: step.produces });
    st.status = 'in_flight';
    st.intentTs = this.now;
    this.maybeCrash('before-effect', step.id);
    for (const p of step.produces) {
      fs.writeFileSync(
        path.join(this.stateDir, p),
        JSON.stringify({ product: p, step: step.id, attempt: st.attempt, ts: this.now }) + '\n',
      );
    }
    const effect = this.append({ type: 'effect', step: step.id, attempt: st.attempt, produces: step.produces });
    st.status = 'effected';
    st.effect = effect;
    this.maybeCrash('after-effect', step.id);
    if (this.crashAt && this.crashAt.point === 'during-checkpoint' && this.crashAt.step === step.id) {
      const partial = JSON.stringify(
        Object.assign({ v: 1, ts: this.now }, { type: 'checkpoint', step: step.id, attempt: st.attempt, status: 'done' }),
      );
      appendRaw(this.journalPath, partial.slice(0, Math.floor(partial.length / 2)));
      process.exit(CRASH_EXIT_CODE);
    }
    const cp = this.append({ type: 'checkpoint', step: step.id, attempt: st.attempt, status: 'done' });
    st.status = 'done';
    st.checkpoint = cp;
  }

  run() {
    const { report, derived } = this.recover();
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const step of this.protocol.steps) {
        const st = derived.steps[step.id];
        if (st.status !== 'pending') continue;
        if (!this.requiresVisible(step, derived)) continue;
        if (this.abortStep === step.id) {
          this.abortStepNow(step.id, derived, 'operator');
        } else {
          this.executeStep(step, st);
        }
        progressed = true;
      }
    }
    return { report, result: this.buildResult(derived) };
  }

  abort(stepId, reason) {
    const { derived } = this.recover();
    return this.abortStepNow(stepId, derived, reason || 'operator');
  }

  buildResult(derived) {
    const steps = {};
    let status = 'completed';
    for (const s of this.protocol.steps) {
      const st = derived.steps[s.id];
      steps[s.id] = { status: st.status, attempts: st.attempt };
      if (st.status === 'discarded') status = 'failed';
      else if (st.status === 'aborted' && status === 'completed') status = 'aborted';
    }
    for (const s of this.protocol.steps) {
      const stt = derived.steps[s.id].status;
      if ((stt === 'pending' || stt === 'in_flight' || stt === 'effected') && status === 'completed') {
        status = 'incomplete';
      }
    }
    const products = fs
      .readdirSync(this.stateDir)
      .filter((f) => !f.endsWith('.consumed') && f !== 'protocol.json')
      .sort();
    const consumed = derived.compensations.filter((c) => c.action === 'mark-consumed').map((c) => c.product);
    return {
      protocol: this.protocol.name,
      status,
      steps,
      products,
      consumed,
      compensations: derived.compensations,
      generatedAt: this.now,
    };
  }
}

module.exports = { Engine, EngineError, CRASH_EXIT_CODE };
