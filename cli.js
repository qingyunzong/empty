#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { Ledger } = require('./src/ledger');

function replay(file, opts = {}) {
  const autoRepair = Boolean(opts.repair);
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  const ledger = new Ledger();
  for (let i = 0; i < lines.length; i++) {
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      const err = new Error(`CORRUPT_JOURNAL: unparseable input at line ${i + 1}`);
      err.code = 'CORRUPT_JOURNAL';
      throw err;
    }
    ledger.apply(event);
    if (autoRepair && event.account) {
      const acc = ledger.accounts.get(event.account);
      if (acc && acc.status === 'ERROR') {
        ledger.apply({ id: `${event.id}#repair`, type: 'repair', account: event.account });
      }
    }
  }
  return { accounts: ledger.summary(), errors: ledger.errors, undoPlans: ledger.undoPlans };
}

function main(argv) {
  const [cmd, file, ...flags] = argv;
  if (cmd !== 'replay' || !file) {
    console.error('usage: node cli.js replay <journal.jsonl> [--repair]');
    return 2;
  }
  try {
    const out = replay(file, { repair: flags.includes('--repair') });
    console.log(JSON.stringify(out, null, 2));
    return 0;
  } catch (e) {
    console.error(JSON.stringify({ error: e.code || 'CORRUPT_JOURNAL', message: e.message }));
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { replay, main };
