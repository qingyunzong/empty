#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { runNetting } from './src/engine.js';
import { NetError, E } from './src/errors.js';

const USAGE = 'Usage: net run <rules.net> <obs.json> --proof <proof.json>';

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'run' || rest.length < 2) {
    console.error(USAGE);
    process.exit(2);
  }
  const [rulesPath, obsPath, ...flags] = rest;
  let proofPath = null;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--proof' && i + 1 < flags.length) {
      proofPath = flags[++i];
    } else {
      console.error(`unknown flag: ${flags[i]}\n${USAGE}`);
      process.exit(2);
    }
  }
  try {
    const rules = readFileSync(rulesPath, 'utf8');
    let obs;
    try {
      obs = JSON.parse(readFileSync(obsPath, 'utf8'));
    } catch (cause) {
      throw new NetError(E.PARSE, `invalid JSON in ${obsPath}: ${cause.message}`);
    }
    const proof = runNetting(rules, obs);
    if (proofPath) writeFileSync(proofPath, JSON.stringify(proof, null, 2) + '\n');
    for (const [ccy, r] of Object.entries(proof.currencies)) {
      console.log(
        `${ccy}: gross=${r.gross} cancelled=${r.cancelled} minCash=${r.minCash} solutions=${r.solutions.length}`,
      );
    }
    console.log(proofPath ? `proof written to ${proofPath}` : JSON.stringify(proof));
  } catch (e) {
    if (e instanceof NetError) {
      console.error(`${e.code}: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main(process.argv.slice(2));
