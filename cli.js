#!/usr/bin/env node
'use strict';
const snap = require('./snapshot.js');

const USAGE = `usage:
  node cli.js write <repo> <srcDir>      # SNAP_FAULT=chunk-partial|journal-uncommitted|index-no-fsync to inject
  node cli.js resume <repo>
  node cli.js verify <repo> [version]
  node cli.js diff <repo> <a> <b>
  node cli.js materialize <repo> <version> <destDir>`;

// Returns process exit code; errors are reported as JSON on stderr.
function main(argv, io, env) {
  const out = (x) => io.stdout(JSON.stringify(x) + '\n');
  const fail = (code, message, details) => {
    const e = { error: code, message };
    if (details !== undefined) e.details = details;
    io.stderr(JSON.stringify(e) + '\n');
    return 1;
  };
  const [cmd, ...args] = argv;
  const fault = (env && env.SNAP_FAULT) || null;
  try {
    switch (cmd) {
      case 'write':
        out(snap.writeSnapshot(args[0], args[1], { fault }));
        return 0;
      case 'resume':
        out(snap.resume(args[0]));
        return 0;
      case 'verify':
        out(snap.verify(args[0], args[1] !== undefined ? Number(args[1]) : undefined));
        return 0;
      case 'diff':
        out(snap.diff(args[0], Number(args[1]), Number(args[2])));
        return 0;
      case 'materialize':
        out(snap.materialize(args[0], Number(args[1]), args[2]));
        return 0;
      default:
        io.stderr(USAGE + '\n');
        return 2;
    }
  } catch (e) {
    if (e instanceof snap.SimulatedCrash) return fail('ERR_CRASH', e.message, { point: e.point });
    if (e instanceof snap.SnapError) return fail(e.code, e.message, e.details);
    return fail('ERR_CRASH', String((e && e.message) || e));
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  }, process.env);
}

module.exports = { main };
