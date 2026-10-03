#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Reassembler } = require('./lib/link');
const { decodeFrame } = require('./lib/frame');
const { Engine, bankName } = require('./lib/engine');

function fmtEvent(e) {
  switch (e.kind) {
    case 'tick': return `[tick] virtual clock += ${e.delta}ms -> ${e.clock}ms`;
    case 'obligation': return `[obligation] cycle=${e.cycle} ${e.from}->${e.to} ${e.amount} ${e.ccy} seq=${e.seq}${e.late ? ' (late, redirected)' : ''}`;
    case 'duplicate-frame': return `[dup] retransmitted ${e.type} from=${e.from} seq=${e.seq} cycle=${e.cycle} ignored`;
    case 'buffered': return `[buffer] ${e.type} from=${e.from} seq=${e.seq} belongs to next cycle ${e.cycle}; queued`;
    case 'late-redirect': return `[late] ${e.type} from=${e.from} seq=${e.seq} arrived for closed cycle ${e.frameCycle}; redirected to cycle ${e.cycle}`;
    case 'seq-conflict': return `[conflict] cycle=${e.cycle} obligation from=${e.from} seq=${e.seq} conflicts with an existing seq; rejected`;
    case 'ack': return `[ack] cycle=${e.cycle} ${e.from} confirmed ${e.forBank} seq=${e.seq}`;
    case 'ack-duplicate': return `[ack] cycle=${e.cycle} duplicate ack from=${e.from} for ${e.forBank} seq=${e.seq}; already confirmed, ignored`;
    case 'ack-pending': return `[ack] cycle=${e.cycle} out-of-order ack from=${e.from} for ${e.forBank} seq=${e.seq}; held until obligation arrives`;
    case 'ack-ignored': return `[ack] cycle=${e.cycle} ack from=${e.from} seq=${e.seq} ignored: ${e.note}`;
    case 'ack-expired': return `[ack] cycle=${e.cycle} pending ack ${e.key} expired at cycle close`;
    case 'nak': return `[nak] cycle=${e.cycle} ${e.from} rejected ${e.forBank} seq=${e.seq} reason=${e.reason}${e.supersededAck ? ' (supersedes earlier ack)' : ''}`;
    case 'nak-pending': return `[nak] cycle=${e.cycle} out-of-order nak from=${e.from} for ${e.forBank} seq=${e.seq} reason=${e.reason}; held until obligation arrives`;
    case 'nak-expired': return `[nak] cycle=${e.cycle} pending nak ${e.key} expired at cycle close`;
    case 'cancel': return `[cancel] cycle=${e.cycle} ${e.from} cancelled seq=${e.seq}${e.late ? ' (late, redirected)' : ''}${e.note ? ` (${e.note})` : ''}`;
    case 'cancel-pending': return `[cancel] cycle=${e.cycle} ${e.from} seq=${e.seq}: no such obligation; held${e.late ? ' (late, redirected)' : ''}`;
    case 'cancel-duplicate': return `[cancel] cycle=${e.cycle} ${e.from} seq=${e.seq} already cancelled`;
    case 'cancel-expired': return `[cancel] cycle=${e.cycle} pending cancel ${e.key} expired at cycle close`;
    case 'freeze': return `[freeze] cycle=${e.cycle} ${e.bank} ${e.amount} ${e.ccy} frozen`;
    case 'release': return `[release] cycle=${e.cycle} ${e.bank} ${e.amount} ${e.ccy} released (${e.reason})`;
    case 'credit': return `[credit] cycle=${e.cycle} ${e.bank} +${e.amount} ${e.ccy}`;
    case 'compensation': return `[compensation] cycle=${e.cycle} ${e.bank} ${e.amount} ${e.ccy}`;
    case 'unwind': return `[unwind] cycle=${e.cycle} ccy=${e.ccy}: ${e.reason}`;
    case 'cycle-close': return `[cycle] cycle ${e.cycle} closed @clock=${e.clock}ms`;
    default: return `[${e.kind}]`;
  }
}

function matrixLines(res, cycle) {
  const banks = res.banks;
  const names = banks.map(bankName);
  const cells = banks.map((i) => banks.map((j) => (i === j ? '-' : (res.matrix.get(`${i}->${j}`) || 0n).toString())));
  const w = Math.max(3, ...names.map((n) => n.length), ...cells.flat().map((s) => s.length));
  const lines = [`[matrix ${res.ccy} cycle ${cycle}]`];
  lines.push('  ' + ' '.repeat(w) + ' ' + names.map((n) => n.padStart(w)).join(' '));
  names.forEach((n, idx) => {
    lines.push('  ' + n.padStart(w) + ' ' + cells[idx].map((c) => c.padStart(w)).join(' '));
  });
  return lines;
}

function cycleLines(res) {
  const lines = [`== cycle ${res.cycle} closed @clock=${res.clock}ms ==`];
  if (res.ccys.length === 0) {
    lines.push('  (no active obligations)');
    return lines;
  }
  for (const r of res.ccys) {
    lines.push(...matrixLines(r, res.cycle));
    lines.push(`[net ${r.ccy} cycle ${res.cycle}] ` + r.banks.map((b) => `${bankName(b)}=${(r.net.get(b) || 0n).toString()}`).join(' '));
    if (r.status === 'settled') {
      lines.push(`[result ${r.ccy} cycle ${res.cycle}] settled`);
    } else {
      lines.push(`[result ${r.ccy} cycle ${res.cycle}] UNWOUND`);
      const ct = r.certificate;
      lines.push(`[unwind-certificate ${r.ccy} cycle ${res.cycle}]`);
      lines.push(`  reason: ${ct.reason}`);
      lines.push('  obligations:');
      for (const o of ct.obligations) lines.push(`    ${o.from}->${o.to} ${o.amount} ${o.ccy} seq=${o.seq}`);
      lines.push('  compensations:');
      for (const comp of ct.compensations) lines.push(`    ${comp.bank} ${comp.amount} ${r.ccy}`);
      lines.push('  partial-settlement: forbidden (all freezes restored)');
    }
  }
  return lines;
}

function printReport(engine, frameCount) {
  const out = [];
  out.push(`fx-netting report: frames=${frameCount} cycle_ms=${engine.cycleMs} final_clock=${engine.clock}ms open_cycle=${engine.openCycle}`);
  out.push('-- events --');
  for (const e of engine.events) out.push(fmtEvent(e));
  out.push('-- cycles --');
  for (const res of engine.closed) out.push(...cycleLines(res));
  const st = engine.cycles.get(engine.openCycle);
  if (st && st.obligations.size) {
    out.push(`[open] cycle ${engine.openCycle} holds ${st.obligations.size} unsettled obligation(s); awaiting tick`);
  }
  const snap = engine.positionsSnapshot();
  if (snap) {
    out.push('-- final positions --');
    for (const bank of Object.keys(snap).sort()) {
      out.push(`  ${bank}: ` + Object.entries(snap[bank]).map(([c, a]) => `${c}=${a}`).join(' '));
    }
  }
  console.log(out.join('\n'));
}

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node cli.js <frames.bin>');
    console.error('env: FX_CYCLE_MS (default 60000), FX_POSITIONS (JSON, e.g. {"A":{"USD":100}}; unset = unlimited liquidity)');
    process.exit(1);
  }
  let stream;
  try {
    stream = fs.readFileSync(file);
  } catch (e) {
    console.error(`error: cannot read ${file}: ${e.message}`);
    process.exit(1);
  }
  const cycleMs = Number(process.env.FX_CYCLE_MS || 60000);
  let positions = null;
  if (process.env.FX_POSITIONS) {
    try {
      positions = JSON.parse(process.env.FX_POSITIONS);
    } catch {
      console.error('error: FX_POSITIONS is not valid JSON');
      process.exit(1);
    }
  }
  const engine = new Engine({ cycleMs, positions });
  const link = new Reassembler();
  let frames;
  try {
    frames = link.feed(stream);
  } catch (e) {
    console.error(`link error: ${e.message}`);
    process.exit(e.exitCode || 2);
  }
  for (const w of link.warnings) console.log(`[link] ${w}`);
  let n = 0;
  try {
    for (const fb of frames) {
      const f = decodeFrame(fb);
      n++;
      engine.ingest(f);
    }
  } catch (e) {
    if (e.exitCode) {
      console.error(`error: ${e.message}`);
      process.exit(e.exitCode);
    }
    throw e;
  }
  if (link.pending.size) {
    console.log(`[link] ${link.pending.size} incomplete frame(s) at EOF: ids=${[...link.pending.keys()].join(',')}`);
  }
  printReport(engine, n);
}

main();
