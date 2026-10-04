#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { recover } = require('./src/journal');
const { LedgerError } = require('./src/errors');

const USAGE = 'usage: node cli.js replay <journal.jsonl> [--repair] [--undo <eventId>]\n';

// Runs the CLI. Returns the exit code; output goes to the injected writers so
// the function can be driven in-process from tests.
function run(argv, io = {}) {
  const stdout = io.stdout || ((s) => process.stdout.write(s));
  const stderr = io.stderr || ((s) => process.stderr.write(s));
  try {
    const [cmd, ...rest] = argv;
    if (cmd !== 'replay' || rest.length === 0) {
      stderr(USAGE);
      return 2;
    }
    const path = rest[0];
    const repair = rest.includes('--repair');
    const undoIdx = rest.indexOf('--undo');
    const undoTarget = undoIdx >= 0 ? rest[undoIdx + 1] : undefined;

    const lines = fs.readFileSync(path, 'utf8').split('\n');

    // Accept either journal records ({type:...}) or a raw JSONL event stream.
    const nonEmpty = lines.map((l) => l.trim()).filter((l) => l !== '');
    let journalLines = lines;
    if (nonEmpty.length > 0) {
      let first;
      try { first = JSON.parse(nonEmpty[0]); } catch { first = null; }
      if (first && !first.type && first.op) {
        journalLines = nonEmpty.map((l) => JSON.stringify({ type: 'event', event: JSON.parse(l) }));
        journalLines.push(JSON.stringify({ type: 'head', event: JSON.parse(nonEmpty[nonEmpty.length - 1]).id }));
      }
    }

    const result = recover(journalLines, { repair });
    const out = {
      head: result.head,
      accounts: result.ledger.getState().accounts,
      repairs: result.repairs,
      ignoredEvents: result.ignored,
      undoPlan: null,
    };
    const target = undoTarget !== undefined ? undoTarget : result.head;
    if (target) {
      try {
        out.undoPlan = result.ledger.undoPlan(target);
      } catch (err) {
        if (!(err instanceof LedgerError)) throw err;
        out.undoPlan = null;
        out.undoError = { code: err.code, message: err.message, witness: (err.details && err.details.witness) || null };
      }
    }
    stdout(JSON.stringify(out, null, 2) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof LedgerError) {
      stderr(JSON.stringify({ error: { code: err.code, message: err.message } }) + '\n');
      return 1;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
