// JSONL CLI: reads one JSON command per line from stdin, writes one JSON
// response per line to stdout. BigInts are serialized as decimal strings;
// fractions as {"num": "...", "den": "..."}.
//
// Commands:
//   {"op":"account","id":"A","funds":{"num":"100","den":"1"}}
//   {"op":"instrument","id":"X","price":{"num":"3","den":"2"}}
//   {"op":"order","id":"O1","account":"A","side":"buy","instrument":"X",
//    "qty":"3","limit":{"num":"2","den":"1"}}
//   {"op":"trial","window":"W1","budget":100000,"proof":true}
//   {"op":"verify","window":"W1"}
//   {"op":"commit","window":"W1","submit":"S1"}
//   {"op":"undo","window":"W1"}
//   {"op":"compensate","window":"W1","submit":"C1"}
//   {"op":"state"}

import readline from 'node:readline';
import { Engine } from './engine.js';
import { frac } from './fraction.js';

function parseBig(v) {
  return BigInt(v);
}

function parseFrac(v) {
  if (v !== null && typeof v === 'object') return frac(parseBig(v.num), parseBig(v.den ?? 1));
  return frac(parseBig(v));
}

function replacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

export function handleCommand(engine, cmd) {
  try {
    switch (cmd.op) {
      case 'account':
        return engine.setAccount(cmd.id, parseFrac(cmd.funds));
      case 'instrument':
        return engine.setInstrument(cmd.id, parseFrac(cmd.price));
      case 'order':
        return engine.setOrder(cmd.id, {
          account: cmd.account,
          side: cmd.side,
          instrument: cmd.instrument,
          qty: parseBig(cmd.qty),
          limit: parseFrac(cmd.limit),
        });
      case 'trial':
        return engine.trial(cmd.window, {
          budget: cmd.budget === undefined ? 100000 : Number(cmd.budget),
          proof: cmd.proof !== false,
          instruments: cmd.instruments,
        });
      case 'verify':
        return engine.verifyTrial(cmd.window);
      case 'commit':
        return engine.commit(cmd.window, cmd.submit);
      case 'undo':
        return engine.undo(cmd.window);
      case 'compensate':
        return engine.compensate(cmd.window, cmd.submit);
      case 'state':
        return engine.state();
      default:
        return { ok: false, error: 'E_OP', detail: `unknown op ${cmd.op}` };
    }
  } catch (e) {
    return { ok: false, error: e.code || 'E_INTERNAL', detail: String(e.message || e) };
  }
}

export function runCLI(input, output = (line) => console.log(line)) {
  const engine = new Engine();
  const rl = readline.createInterface({ input, terminal: false });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let cmd;
    try {
      cmd = JSON.parse(trimmed);
    } catch {
      output(JSON.stringify({ ok: false, error: 'E_PARSE', detail: 'invalid JSON' }));
      return;
    }
    output(JSON.stringify(handleCommand(engine, cmd), replacer));
  });
  return new Promise((resolve) => rl.on('close', resolve));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await runCLI(process.stdin);
}
