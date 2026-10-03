'use strict';

// Runs the three acceptance scenarios against the real CLI and prints the
// recovery reports and head hashes so they can be recorded in test-result.txt.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'cli.js');
let n = 0;

function run(args) {
  n += 1;
  const outFile = path.join(os.tmpdir(), `demo-${process.pid}-${n}.txt`);
  const fd = fs.openSync(outFile, 'w');
  let res;
  try {
    res = spawnSync(process.execPath, [CLI, ...args], { stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
  const stdout = fs.readFileSync(outFile, 'utf8');
  fs.unlinkSync(outFile);
  if (res.error) throw res.error;
  return { status: res.status, stdout };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-demo-'));

console.log('=== scenario 1: reserve, crash afterAppend (exit 42), restart, commit ===');
const f1 = path.join(dir, 's1.jsonl');
const crash = run(['reserve', f1, 'alice', '40', '--event-id', 'e1', '--limit', '100', '--crash', 'afterAppend']);
console.log('crash exit code:', crash.status);
const recovered = JSON.parse(run(['state', f1, '--limit', '100']).stdout);
console.log('recovery report:', JSON.stringify(recovered.recovery));
console.log('held after restart:', recovered.state.accounts.alice.held);
run(['commit', f1, 'alice', '15', '--event-id', 'e2', '--limit', '100']);
const final1 = JSON.parse(run(['state', f1, '--limit', '100']).stdout);
console.log('final state:', JSON.stringify(final1.state.accounts.alice));
console.log('head hash:', final1.state.headHash);

console.log('=== scenario 2: crash beforeAppend, retry, duplicate eventId ===');
const f2 = path.join(dir, 's2.jsonl');
const before = run(['reserve', f2, 'bob', '30', '--event-id', 'dup-1', '--limit', '100', '--crash', 'beforeAppend']);
console.log('crash exit code:', before.status);
console.log('file bytes after beforeAppend crash:', fs.existsSync(f2) ? fs.readFileSync(f2).length : 0);
run(['reserve', f2, 'bob', '30', '--event-id', 'dup-1', '--limit', '100']);
const dup = run(['reserve', f2, 'bob', '30', '--event-id', 'dup-1', '--limit', '100']);
console.log('duplicate retry exit code:', dup.status, '(no-op)');
const final2 = JSON.parse(run(['state', f2, '--limit', '100']).stdout);
console.log('held (single deduction):', final2.state.accounts.bob.held);
console.log('recovery report:', JSON.stringify(final2.recovery));
console.log('head hash:', final2.state.headHash);

console.log('=== scenario 3: tamper last line, restart truncates ===');
const f3 = path.join(dir, 's3.jsonl');
run(['reserve', f3, 'carol', '10', '--event-id', 't1', '--limit', '100']);
run(['reserve', f3, 'carol', '20', '--event-id', 't2', '--limit', '100']);
const buf = fs.readFileSync(f3);
buf[buf.length - 2] = buf[buf.length - 2] === 48 ? 49 : 48;
fs.writeFileSync(f3, buf);
const final3 = JSON.parse(run(['state', f3, '--limit', '100']).stdout);
console.log('recovery report:', JSON.stringify(final3.recovery));
console.log('held after truncation:', final3.state.accounts.carol.held);
console.log('head hash:', final3.state.headHash);
