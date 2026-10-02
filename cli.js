#!/usr/bin/env node
import fs from 'node:fs';
import { begin, add, rewrite, commit, recover, status } from './src/daybook.js';
import { DaybookError, FaultInjected, EXIT } from './src/store.js';

// NOTE: use synchronous writes so output is flushed even when the process
// exits immediately (and under sandboxes that defer async stdio).
const out = (s) => fs.writeSync(1, `${s}\n`);
const err = (s) => fs.writeSync(2, `${s}\n`);

function usage() {
  err(
    [
      'usage: day [--dir DIR] <command> [args]',
      '  begin <date>          open a new settlement day (YYYY-MM-DD)',
      '  add <entry-json>      append entry: {"id","account","amount","type"?,"reversalOf"?}',
      '  rewrite <plan.json>   rewrite the open day: {"date"?,"dropIds"?,"moveBefore"?,"fixAmounts"?}',
      '  commit                commit the open day',
      '  recover               recover after a crash and repair the store',
      '  status                print status (OLD_COMMITTED|OPEN_OLD|OPEN_NEW|COMMITTED_NEW) + basis files',
      'env: DAYBOOK_DIR (default ./.daybook), DAYBOOK_FAULT_AT=before-fsync|before-rename|after-head',
    ].join('\n'),
  );
  process.exit(EXIT.STATE);
}

const argv = process.argv.slice(2);
let dir = process.env.DAYBOOK_DIR ?? './.daybook';
while (argv[0] === '--dir') {
  argv.shift();
  dir = argv.shift();
}
const [cmd, ...rest] = argv;
const faultAt = process.env.DAYBOOK_FAULT_AT ?? null;

try {
  let result;
  switch (cmd) {
    case 'begin':
      if (rest.length !== 1) usage();
      result = begin(dir, rest[0], { faultAt });
      break;
    case 'add':
      if (rest.length !== 1) usage();
      result = add(dir, JSON.parse(rest[0]), { faultAt });
      break;
    case 'rewrite':
      if (rest.length !== 1) usage();
      result = rewrite(dir, JSON.parse(fs.readFileSync(rest[0], 'utf8')), { faultAt });
      break;
    case 'commit':
      result = commit(dir, { faultAt });
      break;
    case 'recover':
      result = recover(dir);
      break;
    case 'status':
      result = status(dir);
      break;
    default:
      usage();
  }
  out(JSON.stringify(result));
} catch (e) {
  if (e instanceof FaultInjected) {
    err(`FAULT_INJECTED ${e.point}`);
    process.exit(EXIT.FAULT);
  }
  if (e instanceof DaybookError) {
    const body = { error: e.code, message: e.message };
    if (e.reason) body.reason = e.reason;
    err(JSON.stringify(body));
    process.exit(e.exitCode);
  }
  err(String(e?.message ?? e));
  process.exit(1);
}
