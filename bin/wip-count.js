#!/usr/bin/env node
'use strict';
const { parseArgs } = require('node:util');
const wip = require('../src/index.js');
const { WipError } = require('../src/errors.js');

const COMMANDS = {
  init:   { options: { node: { type: 'string' } } },
  begin:  { options: { session: { type: 'string' }, node: { type: 'string' } } },
  scan:   { options: { session: { type: 'string' }, bin: { type: 'string' }, item: { type: 'string' }, qty: { type: 'string' } } },
  adjust: { options: { session: { type: 'string' }, bin: { type: 'string' }, item: { type: 'string' }, delta: { type: 'string' } } },
  undo:   { options: { session: { type: 'string' } } },
  close:  { options: { session: { type: 'string' } } },
  sync:   { options: { peer: { type: 'string' } } },
  resume: { options: {} },
  verify: { options: {} },
};

function out(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

function fail(err) {
  const exitCode = err instanceof WipError ? err.exitCode : 1;
  const code = err instanceof WipError ? err.code : 'INTERNAL';
  process.stderr.write(JSON.stringify({ error: { code, message: err.message } }) + '\n');
  process.exit(exitCode);
}

function need(values, name) {
  if (values[name] === undefined) {
    fail(new WipError('USAGE', `missing required --${name}`, 2));
  }
  return values[name];
}

function main() {
  const [cmd, ...rawArgs] = process.argv.slice(2);
  // parseArgs rejects "--opt -1"; normalize negative-number values to --opt=-1
  const rest = [];
  for (let i = 0; i < rawArgs.length; i++) {
    if (/^--[a-z][a-z-]*$/.test(rawArgs[i]) && i + 1 < rawArgs.length && /^-\d/.test(rawArgs[i + 1])) {
      rest.push(`${rawArgs[i]}=${rawArgs[i + 1]}`);
      i++;
    } else {
      rest.push(rawArgs[i]);
    }
  }
  const spec = COMMANDS[cmd];
  if (!spec) {
    fail(new WipError('USAGE', `unknown command ${JSON.stringify(cmd)}; expected one of: ${Object.keys(COMMANDS).join(', ')}`, 2));
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      options: { dir: { type: 'string' }, ...spec.options },
      allowPositionals: false,
    }));
  } catch (err) {
    fail(new WipError('USAGE', err.message, 2));
  }
  const dir = values.dir || process.env.WIP_DIR || 'wip-data';
  const store = new wip.Store(dir);
  try {
    switch (cmd) {
      case 'init': {
        const node = need(values, 'node');
        store.init(node);
        out({ ok: true, dir, node });
        break;
      }
      case 'begin':
        out(wip.begin(store, { session: need(values, 'session'), node: values.node }));
        break;
      case 'scan':
        out(wip.scan(store, {
          session: need(values, 'session'),
          bin: need(values, 'bin'),
          item: need(values, 'item'),
          qty: values.qty === undefined ? 1 : Number(values.qty),
        }));
        break;
      case 'adjust':
        out(wip.adjust(store, {
          session: need(values, 'session'),
          bin: need(values, 'bin'),
          item: need(values, 'item'),
          delta: Number(need(values, 'delta')),
        }));
        break;
      case 'undo':
        out(wip.undo(store, { session: need(values, 'session') }));
        break;
      case 'close':
        out(wip.close(store, { session: need(values, 'session') }));
        break;
      case 'sync': {
        const peer = need(values, 'peer');
        wip.resume(store);
        const peerStore = new wip.Store(peer);
        wip.resume(peerStore);
        out(wip.sync(store, peerStore));
        break;
      }
      case 'resume':
        out(wip.resume(store));
        break;
      case 'verify':
        out(wip.verify(store));
        break;
    }
  } catch (err) {
    fail(err);
  }
}

main();
