'use strict';

const { loadHistory, replay } = require('./history');
const { snapshot, certificate } = require('./core');

const USAGE = `usage:
  node cli.js replay <history.json...>   replay merged histories, print state JSON
  node cli.js cert <claimId> <history.json...>   print certificate JSON for a claim
Use "-" as a file name to read a history document from stdin.`;

// io: { out(text), err(text), readStdin() } — injectable for testing.
function runCli(argv, io) {
  const [cmd, ...rest] = argv;
  const load = (f) => loadHistory(f, f === '-' ? io.readStdin() : undefined);
  if (cmd === 'replay' && rest.length >= 1) {
    const store = replay(rest.flatMap(load));
    io.out(JSON.stringify(snapshot(store), null, 2) + '\n');
    return 0;
  }
  if (cmd === 'cert' && rest.length >= 2) {
    const [claimId, ...files] = rest;
    const store = replay(files.flatMap(load));
    io.out(JSON.stringify(certificate(store, claimId), null, 2) + '\n');
    return 0;
  }
  io.err(USAGE + '\n');
  return 2;
}

module.exports = { runCli, USAGE };
