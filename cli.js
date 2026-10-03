#!/usr/bin/env node
'use strict';

const store = require('./lib/store');

const USAGE =
  'usage:\n' +
  '  node cli.js write <repo> <srcDir>\n' +
  '  node cli.js resume <repo>\n' +
  '  node cli.js verify <repo>\n' +
  '  node cli.js diff <repo> <versionA> <versionB>\n' +
  '  node cli.js materialize <repo> <version> <outDir>\n';

function main(argv, env, io) {
  const [cmd, repo, ...args] = argv;
  if (!cmd || !repo) {
    io.stderr(USAGE);
    return 2;
  }
  try {
    switch (cmd) {
      case 'write': {
        const fault = env.SNAP_FAULT ? { type: env.SNAP_FAULT } : null;
        io.stdout(JSON.stringify(store.writeSnapshot(repo, args[0], { fault })) + '\n');
        return 0;
      }
      case 'resume':
        io.stdout(JSON.stringify(store.resume(repo)) + '\n');
        return 0;
      case 'verify':
        io.stdout(JSON.stringify(store.verify(repo)) + '\n');
        return 0;
      case 'diff': {
        for (const o of store.diff(repo, args[0], args[1])) {
          io.stdout(o.op + ' ' + o.path + '\n');
        }
        return 0;
      }
      case 'materialize':
        io.stdout(JSON.stringify(store.materialize(repo, args[0], args[1])) + '\n');
        return 0;
      default:
        io.stderr(USAGE);
        return 2;
    }
  } catch (err) {
    const code = err && err.code ? err.code : 'ERR_INTERNAL';
    const message = err && err.message ? err.message : String(err);
    io.stderr(JSON.stringify({ error: code, message }) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const code = main(process.argv.slice(2), process.env, {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(code);
}

module.exports = { main };
