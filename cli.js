#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const core = require('./src/core');

function parseUnavailable(text) {
  if (!text) return [];
  return text.split(',').map((part) => {
    const [s, e] = part.trim().split('-').map(Number);
    return [s, e]; // half-open slot interval [s, e)
  });
}

function loadState(file, config) {
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  return core.createState(config);
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

function execute(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      state: { type: 'string', default: './audit-state.json' },
      source: { type: 'string', default: 'cli' },
      now: { type: 'string', default: '0' },
      case: { type: 'string' },
      dept: { type: 'string' },
      risk: { type: 'string' },
      deadline: { type: 'string' },
      duration: { type: 'string', default: '1' },
      skill: { type: 'string' },
      reviewer: { type: 'string' },
      skills: { type: 'string' },
      unavailable: { type: 'string' },
      level: { type: 'string', default: '1' },
      decision: { type: 'string' },
      out: { type: 'string' },
      verify: { type: 'boolean', default: false },
      config: { type: 'string' },
    },
  });
  const cmd = positionals[0];
  const now = Number(values.now);
  const meta = { time: now, source: values.source };
  const config = values.config ? JSON.parse(values.config) : {};
  const state = loadState(values.state, config);
  let result;
  let dirty = true;

  switch (cmd) {
    case 'open':
      if (values.reviewer) {
        result = {
          reviewer: core.addReviewer(state, meta, {
            id: values.reviewer,
            skills: (values.skills || '').split(',').filter(Boolean),
            unavailable: parseUnavailable(values.unavailable),
          }),
        };
      } else {
        result = {
          case: core.openCase(state, meta, {
            id: values.case,
            dept: values.dept,
            risk: Number(values.risk),
            deadline: Number(values.deadline),
            duration: Number(values.duration),
            skill: values.skill,
          }),
        };
      }
      break;
    case 'assign':
      result = core.runAssign(state, meta);
      break;
    case 'correct':
      result = core.correctRisk(state, meta, { id: values.case, risk: Number(values.risk) });
      break;
    case 'appeal':
      result = { appeal: core.openAppeal(state, meta, { id: values.case, level: Number(values.level) }) };
      break;
    case 'close':
      result = core.closeCase(state, meta, { id: values.case, decision: values.decision });
      break;
    case 'snapshot':
      if (values.verify) {
        const recomputed = core.recomputeCertificate(state.events);
        result = { certificate: state.certificate, recomputed, verified: recomputed === state.certificate };
        dirty = false;
      } else {
        const snap = core.snapshotState(state);
        if (values.out) fs.writeFileSync(values.out, JSON.stringify(snap, null, 2) + '\n');
        result = { certificate: snap.certificate, eventCount: snap.eventCount, out: values.out || null };
      }
      break;
    default:
      throw new core.AuditError('BAD_COMMAND', `unknown command ${cmd}; use open|assign|correct|appeal|close|snapshot`, 1);
  }

  if (dirty) fs.writeFileSync(values.state, JSON.stringify(state, null, 2) + '\n');
  return { ok: true, command: cmd, ...result, certificate: state.certificate };
}

function main(argv) {
  try {
    print(execute(argv));
  } catch (err) {
    if (err instanceof core.AuditError) {
      print({ ok: false, error: err.code, message: err.message });
      process.exitCode = err.exitCode;
    } else {
      print({ ok: false, error: 'INTERNAL', message: err.message });
      process.exitCode = 1;
    }
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { execute };
