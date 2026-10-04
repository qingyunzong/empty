#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Store, StoreError } from './store.js';

function parseTxId(s) {
  return Number(String(s).replace(/^tx/, ''));
}

// Runs one CLI invocation. State lives in <dir> (WAL + state file), so each
// call is equivalent to a separate process invocation.
export function runCli(argv, dir) {
  const [cmd, ...args] = argv;
  const store = new Store(dir);
  const requireCurrent = () => {
    if (store.current == null) throw new StoreError('NO_ACTIVE_TX', 'no active transaction');
    return store.current;
  };
  try {
    switch (cmd) {
      case 'begin':
        return { code: 0, out: `tx${store.begin()}` };
      case 'sub':
        return { code: 0, out: `tx${store.begin(requireCurrent())}` };
      case 'set': {
        const [key, value] = args;
        if (key === undefined || value === undefined) throw new StoreError('USAGE', 'set <key> <value>');
        store.set(requireCurrent(), key, value);
        return { code: 0, out: 'ok' };
      }
      case 'get': {
        const v = store.get(args[0], store.current);
        return { code: 0, out: v === undefined ? '(null)' : String(v) };
      }
      case 'commit': {
        const id = args[0] !== undefined ? parseTxId(args[0]) : requireCurrent();
        store.commit(id);
        return { code: 0, out: `committed tx${id}` };
      }
      case 'abort': {
        const id = args[0] !== undefined ? parseTxId(args[0]) : requireCurrent();
        store.abort(id);
        return { code: 0, out: `aborted tx${id}` };
      }
      case 'undo':
        store.undo(args[0] !== undefined ? parseTxId(args[0]) : null);
        return { code: 0, out: 'ok' };
      case 'redo':
        store.redo();
        return { code: 0, out: 'ok' };
      case 'log': {
        const lines = [`undo-depth=${store.undoStack.length} redo-depth=${store.redoStack.length}`];
        for (const e of store.undoStack) lines.push(`undoable tx${e.id} writes=${JSON.stringify(e.writes)}`);
        for (const e of store.redoStack) lines.push(`redoable tx${e.id} writes=${JSON.stringify(e.writes)}`);
        return { code: 0, out: lines.join('\n') };
      }
      default:
        return { code: 2, err: 'usage: wtx <begin|sub|set|get|commit|abort|undo|redo|log> [args]' };
    }
  } catch (e) {
    if (e instanceof StoreError) return { code: 1, err: `ERROR ${e.code} ${e.message}` };
    throw e;
  } finally {
    store.close();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const dir = process.env.WTX_DIR ?? '.wtx';
  const result = runCli(process.argv.slice(2), dir);
  if (result.out) console.log(result.out);
  if (result.err) console.error(result.err);
  process.exit(result.code);
}
