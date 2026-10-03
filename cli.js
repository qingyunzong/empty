#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const replica = require('./replica');

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        opts[key] = true;
      } else {
        opts[key] = next;
        i += 1;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function loadState(file) {
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.accounts || !parsed.events) {
      fail('invalid-state');
    }
    return parsed;
  }
  return replica.createState();
}

function saveState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function fail(code) {
  emit({ error: code });
  process.exit(1);
}

function requestId(opts) {
  return typeof opts['request-id'] === 'string' ? opts['request-id'] : crypto.randomUUID();
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const command = positional[0];
  const stateFile =
    typeof opts.state === 'string' ? opts.state : process.env.REPLICA_STATE || 'replica-state.json';

  if (command === 'diff' || command === 'merge') {
    const otherFile = positional[1];
    if (!otherFile) fail('invalid-args');
    const state = loadState(stateFile);
    let other;
    try {
      other = JSON.parse(fs.readFileSync(otherFile, 'utf8'));
    } catch {
      fail('invalid-input');
    }
    if (command === 'diff') {
      const missing = replica.diffStates(state, other);
      emit({
        missingFreezes: missing.missingFreezes,
        missingReleases: missing.missingReleases,
        missingMembers: missing.missingMembers,
      });
      return;
    }
    const result = replica.mergeStates(state, other);
    saveState(stateFile, state);
    emit(result);
    return;
  }

  const state = loadState(stateFile);

  switch (command) {
    case 'account': {
      const id = positional[1];
      if (!id) fail('invalid-args');
      if (opts.limit !== undefined) {
        const res = replica.setAccountLimit(state, id, Number(opts.limit));
        if (res.error) fail(res.error);
        saveState(stateFile, state);
      }
      const account = replica.getAccount(state, id);
      if (!account) fail('unknown-account');
      emit(account);
      return;
    }
    case 'freeze': {
      if (!opts.account || !opts.member || opts.amount === undefined) fail('invalid-args');
      const event = replica.makeFreeze(state, {
        id: requestId(opts),
        account: opts.account,
        amount: Number(opts.amount),
        memberId: opts.member,
      });
      const res = replica.applyEvent(state, event);
      if (res.error) fail(res.error);
      saveState(stateFile, state);
      emit(event);
      return;
    }
    case 'release': {
      if (!opts.member || !opts.target) fail('invalid-args');
      const event = replica.makeRelease(state, {
        id: requestId(opts),
        memberId: opts.member,
        target: opts.target,
      });
      const res = replica.applyEvent(state, event);
      if (res.error) fail(res.error);
      saveState(stateFile, state);
      emit(event);
      return;
    }
    case 'add-member': {
      if (!opts.member) fail('invalid-args');
      const event = replica.makeAddMember(state, { id: requestId(opts), memberId: opts.member });
      const res = replica.applyEvent(state, event);
      if (res.error) fail(res.error);
      saveState(stateFile, state);
      emit(event);
      return;
    }
    case 'remove-member': {
      if (!opts.member) fail('invalid-args');
      const event = replica.makeRemoveMember(state, {
        id: requestId(opts),
        memberId: opts.member,
        frontier: typeof opts.frontier === 'string' ? opts.frontier : undefined,
      });
      const res = replica.applyEvent(state, event);
      if (res.error) fail(res.error);
      saveState(stateFile, state);
      emit(event);
      return;
    }
    default:
      fail('invalid-args');
  }
}

try {
  main();
} catch (err) {
  if (process.env.CLI_DEBUG) console.error(err);
  fail('internal');
}
