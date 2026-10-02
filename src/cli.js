import {
  IndexError, loadState, saveState, applyOps, appendLog, readLog,
  undoTo, verify, runQuery, indexHash,
} from './store.js';

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { cmd, dir: '.woindex', to: undefined };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--dir') opts.dir = rest[++i];
    else if (rest[i] === '--to') opts.to = parseInt(rest[++i], 10);
    else throw new IndexError('E_PARSE', `unknown argument: ${rest[i]}`);
  }
  if (!cmd) throw new IndexError('E_PARSE', 'usage: wo <add|del|undo|query|verify> [--dir D] [--to N]');
  return opts;
}

function parseJsonl(text) {
  return text.split('\n').filter((l) => l.trim() !== '').map((line, i) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new IndexError('E_PARSE', `line ${i + 1}: invalid JSON`);
    }
  });
}

function cmdAdd(dir, stdin) {
  const rows = parseJsonl(stdin);
  const ops = rows.map((r, i) => {
    if (typeof r?.id !== 'string' || r.id === '' || typeof r?.text !== 'string') {
      throw new IndexError('E_PARSE', `line ${i + 1}: expected {"id":string,"text":string}`);
    }
    return { op: 'add', id: r.id, text: r.text };
  });
  if (ops.length === 0) throw new IndexError('E_PARSE', 'no input records');
  const state = loadState(dir);
  readLog(dir); // refuse to mutate a corrupt store
  applyOps(state, ops);
  const { seq } = appendLog(dir, ops);
  saveState(dir, state);
  return [{ ok: true, batch: seq, count: ops.length, hash: indexHash(state) }];
}

function cmdDel(dir, stdin) {
  const rows = parseJsonl(stdin);
  const ids = rows.map((r, i) => {
    if (typeof r?.id !== 'string' || r.id === '') {
      throw new IndexError('E_PARSE', `line ${i + 1}: expected {"id":string}`);
    }
    return r.id;
  });
  if (ids.length === 0) throw new IndexError('E_PARSE', 'no input records');
  const state = loadState(dir);
  readLog(dir);
  for (const id of ids) {
    if (!state.docs.has(id)) throw new IndexError('E_NOTFOUND', `doc not found: ${id}`);
  }
  const ops = ids.map((id) => ({ op: 'del', id }));
  applyOps(state, ops);
  const { seq } = appendLog(dir, ops);
  saveState(dir, state);
  return [{ ok: true, batch: seq, count: ops.length, hash: indexHash(state) }];
}

function cmdUndo(dir, to) {
  const state = undoTo(dir, to);
  return [{ ok: true, head: state.head, hash: indexHash(state) }];
}

function cmdQuery(dir, stdin) {
  const rows = parseJsonl(stdin);
  if (rows.length === 0) throw new IndexError('E_PARSE', 'no input records');
  const state = loadState(dir);
  let hadError = false;
  const out = rows.map((r) => {
    try {
      if (typeof r?.q !== 'string') throw new IndexError('E_PARSE', 'expected {"q":string}');
      return { ok: true, results: runQuery(state, r.q) };
    } catch (err) {
      hadError = true;
      const code = err instanceof IndexError ? err.code : 'E_PARSE';
      return { ok: false, error: { code, message: err.message } };
    }
  });
  return { lines: out, hadError };
}

function cmdVerify(dir) {
  const { hash, batches } = verify(dir);
  return [{ ok: true, hash, batches }];
}

// Returns { code, lines } — pure w.r.t. process I/O so tests can call in-process.
export function runCli(argv, stdin = '') {
  try {
    const { cmd, dir, to } = parseArgs(argv);
    let result;
    if (cmd === 'add') result = cmdAdd(dir, stdin);
    else if (cmd === 'del') result = cmdDel(dir, stdin);
    else if (cmd === 'undo') result = cmdUndo(dir, to);
    else if (cmd === 'query') result = cmdQuery(dir, stdin);
    else if (cmd === 'verify') result = cmdVerify(dir);
    else throw new IndexError('E_PARSE', `unknown command: ${cmd}`);
    if (Array.isArray(result)) return { code: 0, lines: result };
    return { code: result.hadError ? 1 : 0, lines: result.lines };
  } catch (err) {
    const code = err instanceof IndexError ? err.code : 'E_PARSE';
    return { code: 1, lines: [{ ok: false, error: { code, message: err.message } }] };
  }
}
