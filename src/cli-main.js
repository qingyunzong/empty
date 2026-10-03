import { readFileSync } from 'node:fs';
import { Engine } from './engine.js';
import { totalOrder } from './order.js';
import { certificate } from './certificate.js';

const USAGE = `usage:
  evidence-claims state <history.json...>   replay merged histories, print state JSON
  evidence-claims cert <claimId> <history.json...>   print certificate JSON for a claim
  evidence-claims order <history.json...>   print the deterministic total order of ops`;

function loadOps(files) {
  const ops = [];
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`cannot read history file "${file}": ${err.message}`);
    }
    const list = Array.isArray(data) ? data : data && data.ops;
    if (!Array.isArray(list)) throw new Error(`history file "${file}" has no op array`);
    ops.push(...list);
  }
  return ops;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'state' || cmd === 'order') {
    if (rest.length === 0) throw new Error('missing history file');
    const ops = totalOrder(loadOps(rest));
    if (cmd === 'order') return ops;
    const engine = new Engine().applyAll(ops);
    return { stateHash: engine.stateHash(), ...engine.snapshot() };
  }
  if (cmd === 'cert') {
    const [claimId, ...files] = rest;
    if (!claimId || files.length === 0) throw new Error('cert needs a claimId and history file(s)');
    const engine = new Engine().applyAll(totalOrder(loadOps(files)));
    return certificate(engine, claimId);
  }
  throw new Error(USAGE);
}

// In-process entry point: returns { code, stdout, stderr } so it can be
// tested without spawning a child process.
export function runCli(argv) {
  try {
    return { code: 0, stdout: JSON.stringify(main(argv), null, 2) + '\n', stderr: '' };
  } catch (err) {
    return {
      code: 1,
      stdout: '',
      stderr: JSON.stringify({ error: { code: 'E_INPUT', message: err.message } }) + '\n',
    };
  }
}
