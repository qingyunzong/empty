import { readFileSync, writeFileSync, appendFileSync, existsSync, writeSync } from 'node:fs';
import { createState } from './state.js';
import { proofOf } from './util.js';
import * as ops from './ops.js';
import { SchedError } from './errors.js';
import { renderTable, buildRows } from './table.js';

function parseFlags(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const num = (v) => (v === true || v == null ? v : Number(v));

function loadState(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function saveState(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n');
}

function loadLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function appendLog(path, ev) {
  appendFileSync(path, JSON.stringify(ev) + '\n');
}

function applyEvent(state, cmd, args) {
  switch (cmd) {
    case 'book': return ops.book(state, args);
    case 'correct': return ops.correct(state, args.id, args.delta);
    case 'maintain': return ops.maintain(state, args.start, args.end);
    case 'cancel': return ops.cancel(state, args.id);
    case 'scan': return ops.scan(state, args.until ?? null);
    default: throw new SchedError('UNKNOWN_EVENT', `未知事件: ${cmd}`, { cmd });
  }
}

function autoId(state) {
  let n = 1;
  while (state.batches['b' + n]) n++;
  return 'b' + n;
}

export function main(argv) {
  try {
    run(argv);
  } catch (e) {
    if (e instanceof SchedError) {
      writeSync(2, JSON.stringify(e.explanation(), null, 2) + '\n');
      process.exitCode = e.exitCode;
    } else {
      writeSync(2, JSON.stringify({ error: 'INTERNAL', message: String(e?.message ?? e) }) + '\n');
      process.exitCode = 1;
    }
  }
}

function run(argv) {
  const { pos, flags } = parseFlags(argv);
  const cmd = pos[0];
  if (!cmd) throw new SchedError('USAGE', '用法: micro <book|scan|correct|maintain|cancel|replay|table|init> [参数]', {});
  const statePath = flags.state ?? 'microstate.json';
  const logPath = flags.log ?? statePath + '.log';
  const json = !!flags.json;

  if (cmd === 'replay') {
    const events = loadLog(logPath);
    const to = flags.to != null ? Number(flags.to) : Infinity;
    let state = null;
    let count = 0;
    for (const ev of events) {
      if (ev.seq > to) break;
      state = ev.cmd === 'init' ? createState(ev.config) : applyEvent(state, ev.cmd, ev.args);
      const p = proofOf(state);
      if (ev.proof !== p) throw new SchedError('PROOF_MISMATCH', `回放证明不匹配 seq=${ev.seq}`, { seq: ev.seq, expected: ev.proof, actual: p });
      count++;
    }
    if (!state) throw new SchedError('EMPTY_LOG', '事件日志为空，无法回放', { log: logPath });
    saveState(statePath, state);
    emit(json, { ok: true, replayed: count, proof: proofOf(state) }, () => `回放 ${count} 个事件，状态证明 ${proofOf(state).slice(0, 16)}`);
    return;
  }

  // 自动初始化（首个变更命令），并记录 init 事件
  let state;
  let events = loadLog(logPath);
  if (!existsSync(statePath)) {
    const config = flags.config ? JSON.parse(readFileSync(flags.config, 'utf8')) : {};
    state = createState(config);
    saveState(statePath, state);
    appendLog(logPath, { seq: events.length + 1, cmd: 'init', config: state.config, proof: proofOf(state) });
    events = loadLog(logPath);
  } else {
    state = loadState(statePath);
  }

  let result = null;
  let args = null;
  switch (cmd) {
    case 'init':
      result = state;
      break;
    case 'book': {
      args = {
        id: pos[1] ?? flags.id ?? autoId(state),
        group: flags.group ?? 'default',
        objective: String(flags.objective ?? ''),
        channels: String(flags.channels ?? flags.channel ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        fields: Number(flags.fields),
        priority: Number(flags.priority ?? 0),
      };
      result = ops.book(state, args);
      break;
    }
    case 'correct': {
      args = { id: pos[1] ?? flags.id, delta: Number(flags.delta) };
      result = ops.correct(state, args.id, args.delta);
      break;
    }
    case 'maintain': {
      args = { start: Number(flags.start), end: Number(flags.end) };
      result = ops.maintain(state, args.start, args.end);
      break;
    }
    case 'cancel': {
      args = { id: pos[1] ?? flags.id };
      result = ops.cancel(state, args.id);
      break;
    }
    case 'scan': {
      args = { until: flags.until != null ? Number(flags.until) : null };
      result = ops.scan(state, args.until);
      break;
    }
    case 'table':
      emit(json, { ok: true, proof: proofOf(state), rows: buildRows(state) }, () => renderTable(state) + `\n状态证明 ${proofOf(state).slice(0, 16)}`);
      return;
    default:
      throw new SchedError('USAGE', `未知命令: ${cmd}`, { cmd });
  }

  if (result !== state) {
    saveState(statePath, result);
    if (args) appendLog(logPath, { seq: events.length + 1, cmd, args, proof: proofOf(result) });
  }
  const proof = proofOf(result);
  const imagedCount = result.imaged.length;
  emit(json,
    { ok: true, cmd, args, generation: result.generation, proof, imaged: imagedCount, rows: buildRows(result) },
    () => renderTable(result) + `\n状态证明 ${proof.slice(0, 16)} (gen=${result.generation}, 已成像=${imagedCount})`);
}

function emit(json, obj, textFn) {
  if (json) writeSync(1, JSON.stringify(obj, null, 2) + '\n');
  else writeSync(1, textFn() + '\n');
}
