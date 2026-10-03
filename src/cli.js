import { readFileSync, writeFileSync } from 'node:fs';
import { NetError } from './errors.js';
import { runNetting, proofToJson } from './engine.js';

const USAGE = `usage:
  net run <rules.net> <obs.json> [--proof <proof.json>]

Error codes: E_CCY E_CYCLE_DUP E_NO_SOL E_PARSE`;

// Returns the process exit code. Injectable io for testing.
export function main(argv, io = { out: console.log, err: console.error }) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run') {
    io.err(USAGE);
    return 2;
  }
  const positional = [];
  let proofPath = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--proof') {
      proofPath = rest[++i];
      if (!proofPath) {
        io.err(USAGE);
        return 2;
      }
    } else {
      positional.push(rest[i]);
    }
  }
  const [rulesPath, obsPath] = positional;
  if (!rulesPath || !obsPath) {
    io.err(USAGE);
    return 2;
  }
  try {
    const rules = readFileSync(rulesPath, 'utf8');
    const obs = JSON.parse(readFileSync(obsPath, 'utf8'));
    const proof = runNetting(rules, obs);
    const json = proofToJson(proof);
    if (proofPath) writeFileSync(proofPath, json + '\n');
    for (const [ccy, sec] of Object.entries(proof.currencies)) {
      io.out(
        `${ccy}: obligations=${sec.obligations.length} gross=${sec.gross} ` +
        `minCash=${sec.minCash} solutions=${sec.solutions.length}${sec.truncated ? ' (truncated)' : ''}`,
      );
      sec.solutions.forEach((sol, i) => {
        io.out(`  solution ${i + 1}: residualTotal=${sol.residualTotal}`);
        for (const c of sol.cycles) {
          io.out(`    cycle ${c.cycle} amount=${c.amount}`);
        }
      });
    }
    if (proofPath) io.out(`proof written to ${proofPath}`);
    return 0;
  } catch (err) {
    if (err instanceof NetError) {
      io.err(err.message);
      return 1;
    }
    throw err;
  }
}
