import { ClearingEngine } from './engine.js';
import { Store } from './store.js';

function parseArgs(argv) {
  let stateDir = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state-dir') stateDir = argv[++i];
    else if (argv[i].startsWith('--state-dir=')) stateDir = argv[i].slice('--state-dir='.length);
    else return { error: `unknown argument ${argv[i]}` };
  }
  return { stateDir };
}

export function runCli({ argv, stdin, writeOut, writeErr }) {
  const { stateDir, error } = parseArgs(argv);
  if (error) {
    writeErr(`error: USAGE: ${error}\n`);
    return 2;
  }

  let engine = new ClearingEngine();
  let store = null;
  if (stateDir) {
    store = new Store(stateDir);
    const { snapshot, events } = store.recover();
    if (snapshot) engine = ClearingEngine.restore(snapshot);
    for (const record of events) {
      if (record.seq <= engine.seq) continue;
      engine.apply(record.event);
    }
  }

  for (const line of stdin.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      writeErr(`error: PARSE: invalid JSON line: ${line.slice(0, 120)}\n`);
      return 2;
    }
    let result;
    try {
      result = engine.apply(event);
    } catch (err) {
      writeErr(`error: ${err.code ?? 'INTERNAL'}: ${err.message}\n`);
      return 2;
    }
    if (store) {
      store.appendEvent({ seq: result.seq, event });
      if (result.changed) store.writeBatch(engine.snapshot());
    }
    writeOut(
      JSON.stringify({
        seq: result.seq,
        changed: result.changed,
        batchSeq: result.batchSeq,
        nets: result.nets,
        certificate: result.certificate,
      }) + '\n',
    );
  }
  return 0;
}
