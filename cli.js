#!/usr/bin/env node
'use strict';
// Usage: node cli.js <frames.bin>
// Exit codes: 0 ok | 1 usage/io | 2 validation | 3 unknown cycle | 4 negative obligation
const fs = require('fs');
const { parseFile, reassemble, decodeFrame, FRAME_TYPE_NAMES, ValidationError } = require('./wire');
const { Engine, UnknownCycleError, NegativeObligationError } = require('./engine');

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node cli.js <frames.bin>');
    process.exitCode = 1;
    return;
  }
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    console.error(`error: cannot read ${file}: ${e.message}`);
    process.exitCode = 1;
    return;
  }
  try {
    const { banks, packets } = parseFile(buf);
    const linkLog = [];
    const frameBufs = reassemble(packets, linkLog);

    console.log('FX BILATERAL NETTING QUEUE');
    console.log('==========================');
    console.log(`banks: ${banks.map((b) => `${b.id}(${b.ccy}=${b.balance})`).join(' ')}`);
    console.log(`link: packets=${packets.length} frames=${frameBufs.length}`);
    for (const line of linkLog) console.log(line);

    const engine = new Engine(banks.map((b) => ({ id: b.id, ccy: b.ccy, balance: b.balance })));
    for (const fb of frameBufs) {
      const frame = decodeFrame(fb);
      engine.submit(frame);
    }
    engine.closeAll();
    for (const line of engine.output) console.log(line);
    for (const line of engine.finalReport()) console.log(line);
    const settled = engine.cycleResults.filter((r) => r.status === 'SETTLED').length;
    const unwound = engine.cycleResults.filter((r) => r.status === 'UNWOUND').length;
    console.log(`SUMMARY cycles=${engine.clock.cycle} settled=${settled} unwound=${unwound} compensations=${engine.compensations.length}`);
  } catch (e) {
    if (e instanceof ValidationError || e instanceof UnknownCycleError || e instanceof NegativeObligationError) {
      console.error(`error[exit=${e.exitCode}] ${e.name}: ${e.message}`);
      process.exitCode = e.exitCode;
      return;
    }
    throw e;
  }
}

main();
