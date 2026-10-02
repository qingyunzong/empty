#!/usr/bin/env node
'use strict';
// Formula correction CLI. Reads one command per line from stdin:
//   def <name> = <expr>       define a new named formula (version 1)
//   correct <name> = <expr>   commit a corrected version (clears redo branch)
//   undo <name>               step back one version
//   redo <name>               step forward one version (if no new correction)
//   certify <name>            SHA-256 certificate of name+version+canonical AST
// Each successful command prints one single-line JSON object to stdout.
// Any lexical/type/unknown-name error prints "error: ..." to stderr and
// exits with code 1 without committing a partial version.
const { FormulaStore, FormulaError } = require('./formula');

function runCommand(store, line) {
  let m;
  if ((m = line.match(/^def\s+([A-Za-z_]\w*)\s*=\s*(\S.*)$/))) {
    const r = store.def(m[1], m[2]);
    return { ok: true, op: 'def', name: r.name, version: r.version };
  }
  if ((m = line.match(/^correct\s+([A-Za-z_]\w*)\s*=\s*(\S.*)$/))) {
    const r = store.correct(m[1], m[2]);
    return { ok: true, op: 'correct', name: r.name, version: r.version };
  }
  if ((m = line.match(/^(undo|redo|certify)\s+([A-Za-z_]\w*)\s*$/))) {
    const r = store[m[1]](m[2]);
    const out = { ok: true, op: m[1], name: r.name, version: r.version };
    if (m[1] === 'certify') out.sha256 = r.sha256;
    return out;
  }
  throw new FormulaError('parse', `unrecognized command: ${line}`);
}

// Pure session runner: feeds `input` (newline-separated commands) to a fresh
// store and returns { stdout, stderr, code } without touching real stdio.
function runSession(input) {
  const store = new FormulaStore();
  const out = [];
  for (const raw of input.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    try {
      out.push(JSON.stringify(runCommand(store, line)));
    } catch (err) {
      const detail = err instanceof FormulaError
        ? `${err.kind}: ${err.message}`
        : String((err && err.message) || err);
      return { stdout: out.length ? out.join('\n') + '\n' : '', stderr: `error: ${detail}\n`, code: 1 };
    }
  }
  return { stdout: out.length ? out.join('\n') + '\n' : '', stderr: '', code: 0 };
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    const { stdout, stderr, code } = runSession(input);
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    if (code !== 0) process.exitCode = code;
  });
  process.stdin.resume();
}

if (require.main === module) main();

module.exports = { runSession, runCommand };
