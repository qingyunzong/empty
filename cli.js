#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const lib = require('./lib/archive');

const USAGE = [
  'usage:',
  '  node cli.js inspect <archiveDir>',
  '  node cli.js planRepair <archiveDir> <knownGoodDir> <maxBytes>',
  '  node cli.js applyPlan <archiveDir> <planFile>',
  '  node cli.js verify <archiveDir>',
  '',
].join('\n');

// Runs one CLI command. Returns the process exit code. io provides
// writeStdout/writeStderr so tests can drive the CLI in-process.
function run(argv, io) {
  const out = io && io.writeStdout ? io.writeStdout : (s) => process.stdout.write(s);
  const err = io && io.writeStderr ? io.writeStderr : (s) => process.stderr.write(s);
  const emit = (value) => out(JSON.stringify(value, null, 2) + '\n');
  const fail = (e) => {
    const code = e && typeof e.code === 'string' && e.code.startsWith('ERR_') ? e.code : 'ERR_IO';
    err(JSON.stringify({ error: code, message: String(e && e.message || e) }) + '\n');
    return 1;
  };

  const [cmd, ...args] = argv;
  try {
    switch (cmd) {
      case 'inspect': {
        if (args.length !== 1) break;
        emit(lib.inspect(args[0]));
        return 0;
      }
      case 'planRepair': {
        if (args.length !== 3) break;
        emit(lib.planRepair(args[0], args[1], args[2]));
        return 0;
      }
      case 'applyPlan': {
        if (args.length !== 2) break;
        let plan;
        try {
          plan = JSON.parse(fs.readFileSync(args[1], 'utf8'));
        } catch (e) {
          throw new lib.ArchiveError('ERR_IO', `cannot read plan ${args[1]}: ${e.message}`);
        }
        emit(lib.applyPlan(args[0], plan));
        return 0;
      }
      case 'verify': {
        if (args.length !== 1) break;
        const report = lib.verify(args[0]);
        emit(report);
        return report.ok ? 0 : 1;
      }
      default:
        break;
    }
    err(USAGE);
    return 2;
  } catch (e) {
    return fail(e);
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
