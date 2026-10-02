#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store, StoreError } from './src/store.js';

const USAGE = `Usage: wx <command> [args]
  begin                 start a new root transaction
  sub                   start a sub-transaction of the current one
  set <key> <value>     write a correction into the current transaction
  del <key>             delete a key in the current transaction
  commit                commit current transaction (root commit hits the WAL)
  abort                 abort current transaction and its children
  undo [txId]           undo a committed transaction (default: most recent)
  redo [txId]           redo an undone transaction (default: most recent)
  log                   show committed transaction history and undo/redo stacks
  get <key>             read a key (committed state overlaid with current tx)
Data dir: WX_DIR env var or ./wxdata`;

class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseValue(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Runs one CLI invocation against `dir`. Returns { code, stdout, stderr }.
// Each call reloads the WAL and the session file, mirroring a real process.
export function runCli(argv, dir) {
  const sessionFile = path.join(dir, 'session.json');
  const out = [];
  const fail = (code, message) => {
    throw new CliError(code, message);
  };
  const loadSession = () => {
    try {
      return JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    } catch {
      return { nextId: 1, current: null, txs: {} };
    }
  };
  const saveSession = (s) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify(s));
  };
  const currentTx = (session) => {
    if (session.current == null || !session.txs[session.current]) {
      fail('CLOSED', 'no open transaction');
    }
    return session.txs[session.current];
  };

  const [cmd, ...args] = argv;
  try {
    if (!cmd || cmd === 'help' || cmd === '--help') {
      return { code: 0, stdout: USAGE, stderr: '' };
    }
    const store = new Store(dir);
    const session = loadSession();
    session.nextId = Math.max(session.nextId, store._nextTxId);
    store._nextTxId = session.nextId;
    try {
      switch (cmd) {
        case 'begin': {
          const id = session.nextId++;
          session.txs[id] = { id, parent: null, ops: [] };
          session.current = id;
          saveSession(session);
          out.push(`tx ${id}`);
          break;
        }
        case 'sub': {
          const parent = currentTx(session);
          const id = session.nextId++;
          session.txs[id] = { id, parent: parent.id, ops: [] };
          session.current = id;
          saveSession(session);
          out.push(`tx ${id} (child of ${parent.id})`);
          break;
        }
        case 'set': {
          const [key, raw] = args;
          if (key === undefined || raw === undefined) fail('USAGE', 'set <key> <value>');
          const tx = currentTx(session);
          tx.ops = tx.ops.filter(([k]) => k !== key);
          tx.ops.push([key, { hasValue: true, value: parseValue(raw) }]);
          saveSession(session);
          out.push('ok');
          break;
        }
        case 'del': {
          const [key] = args;
          if (key === undefined) fail('USAGE', 'del <key>');
          const tx = currentTx(session);
          tx.ops = tx.ops.filter(([k]) => k !== key);
          tx.ops.push([key, { hasValue: false, value: null }]);
          saveSession(session);
          out.push('ok');
          break;
        }
        case 'commit': {
          const tx = currentTx(session);
          const merged = new Map(tx.ops);
          delete session.txs[tx.id];
          if (tx.parent != null && session.txs[tx.parent]) {
            const parent = session.txs[tx.parent];
            const pOps = new Map(parent.ops);
            for (const [k, v] of merged) pOps.set(k, v);
            parent.ops = [...pOps];
            session.current = tx.parent;
            saveSession(session);
            out.push(`tx ${tx.id} merged into tx ${tx.parent}`);
          } else {
            const root = store.begin(tx.id);
            for (const [k, v] of merged) {
              if (v.hasValue) root.set(k, v.value);
              else root.del(k);
            }
            root.commit();
            session.current = null;
            session.nextId = store._nextTxId;
            saveSession(session);
            out.push(`tx ${tx.id} committed`);
          }
          break;
        }
        case 'abort': {
          const tx = currentTx(session);
          const doomed = new Set([tx.id]);
          let grew = true;
          while (grew) {
            grew = false;
            for (const t of Object.values(session.txs)) {
              if (t.parent != null && doomed.has(t.parent) && !doomed.has(t.id)) {
                doomed.add(t.id);
                grew = true;
              }
            }
          }
          for (const id of doomed) delete session.txs[id];
          session.current = tx.parent != null && session.txs[tx.parent] ? tx.parent : null;
          saveSession(session);
          out.push(`tx ${tx.id} aborted`);
          break;
        }
        case 'undo': {
          const id = args[0] !== undefined ? Number(args[0]) : undefined;
          const undoId = store.undo(id);
          session.nextId = store._nextTxId;
          saveSession(session);
          out.push(`undone by tx ${undoId}`);
          break;
        }
        case 'redo': {
          const id = args[0] !== undefined ? Number(args[0]) : undefined;
          const redoId = store.redo(id);
          session.nextId = store._nextTxId;
          saveSession(session);
          out.push(`redone by tx ${redoId}`);
          break;
        }
        case 'log': {
          const log = store.log();
          for (const t of log.txs) {
            const target = t.target != null ? ` target=${t.target}` : '';
            out.push(`tx ${t.id} kind=${t.kind}${target} sets=${JSON.stringify(t.sets)}`);
          }
          out.push(`undoStack=[${log.undoStack.join(',')}] redoStack=[${log.redoStack.join(',')}]`);
          break;
        }
        case 'get': {
          const [key] = args;
          if (key === undefined) fail('USAGE', 'get <key>');
          let found = store.has(key);
          let value = store.get(key);
          const chain = [];
          for (let t = session.txs[session.current]; t; t = session.txs[t.parent]) {
            chain.unshift(t);
          }
          for (const t of chain) {
            for (const [k, op] of t.ops) {
              if (k === key) {
                found = op.hasValue;
                value = op.value;
              }
            }
          }
          out.push(found ? JSON.stringify(value) : '(unset)');
          break;
        }
        default:
          fail('USAGE', `unknown command: ${cmd}`);
      }
    } finally {
      store.close();
    }
    return { code: 0, stdout: out.join('\n'), stderr: '' };
  } catch (e) {
    if (e instanceof CliError || e instanceof StoreError) {
      const stderr =
        e.code === 'USAGE' ? `${e.code}: ${e.message}\n${USAGE}` : `${e.code}: ${e.message}`;
      return { code: 1, stdout: out.join('\n'), stderr };
    }
    throw e;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dir = process.env.WX_DIR || path.join(process.cwd(), 'wxdata');
  const result = runCli(process.argv.slice(2), dir);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}
