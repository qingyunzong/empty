#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Ledger, InterestError } = require('./src/ledger');

const STATE_FILE = process.env.INTEREST_STATE || path.join(process.cwd(), 'interest-state.json');

const USAGE = `usage: node cli.js <command> '<json payload>'
commands:
  loadCurve  {"segments":[{"from":0,"to":30,"coefs":[["1","10"]]}]}
  post       {"day":3,"amountNum":1000,"amountDen":1}
  backdate   {"day":3,"newAmount":["1200","1"]}
  undoPost   {"id":1}
  certify    {"from":0,"to":30}
  verify     {"certId":"cert-1"}
  root
state file: ${STATE_FILE} (override with INTEREST_STATE)`;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Dispatch one command against a state object. Returns
// { code, body, state } where state is the (possibly mutated) state to persist.
function runCommand(cmd, input, state) {
  const ledger = new Ledger(state);
  const mutating = new Set(['loadCurve', 'post', 'backdate', 'undoPost', 'certify']);
  try {
    let out;
    switch (cmd) {
      case 'loadCurve':
        out = ledger.loadCurve(input);
        break;
      case 'post':
        out = ledger.post(input);
        break;
      case 'backdate':
        out = ledger.backdate(input);
        break;
      case 'undoPost':
        out = ledger.undoPost(input);
        break;
      case 'certify':
        out = ledger.certify(input);
        break;
      case 'verify':
        out = ledger.verify(input);
        break;
      case 'root':
        out = { root: ledger.root() };
        break;
      default:
        return { code: 2, body: { error: 'E_ARGS', message: `unknown command ${cmd}` }, state, persist: false };
    }
    return { code: 0, body: out, state: ledger.state, persist: mutating.has(cmd) };
  } catch (e) {
    if (e instanceof InterestError) {
      const body = { error: e.code, message: e.message };
      if (e.details !== undefined) body.details = e.details;
      return { code: 1, body, state, persist: false };
    }
    throw e;
  }
}

function main() {
  const [, , cmd, raw] = process.argv;
  if (!cmd) {
    console.error(USAGE);
    process.exit(2);
  }
  let input = {};
  if (raw !== undefined) {
    try {
      input = JSON.parse(raw);
    } catch {
      console.log(JSON.stringify({ error: 'E_ARGS', message: 'payload must be valid JSON' }));
      process.exit(2);
    }
  }

  const result = runCommand(cmd, input, loadState());
  if (result.code === 0 && result.persist) saveState(result.state);
  console.log(JSON.stringify(result.body));
  process.exit(result.code);
}

if (require.main === module) main();

module.exports = { runCommand };
