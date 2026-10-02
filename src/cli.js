import fs from 'node:fs';
import path from 'node:path';
import {
  compileSchema, PersistentStore, ParamStore, mergeSnapshots,
  RollbackEngine, CertStore, ParamSyncError, EXIT_CODES,
  writeSchema, readSchema,
} from './index.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rollbackStatePath(dir) { return path.join(dir, 'rollback-state.json'); }
function certsPath(dir) { return path.join(dir, 'certs.json'); }

function loadCerts(dir) {
  const cs = new CertStore();
  if (fs.existsSync(certsPath(dir))) {
    for (const c of readJson(certsPath(dir))) cs.certs.set(c.id, c);
  }
  return cs;
}

function saveCerts(dir, cs) {
  fs.writeFileSync(certsPath(dir), JSON.stringify(cs.list(), null, 2));
}

function recoverOpts(ctx) {
  const fault = ctx.env.PARAM_SYNC_FAULT ?? null;
  return fault ? { fault } : {};
}

function loadDb(dir, nodeId, ctx) {
  const defs = readSchema(dir);
  if (!defs) throw new ParamSyncError('VALIDATION', `db at '${dir}' has no schema.json (apply a pack first)`);
  const schema = compileSchema(defs);
  return PersistentStore.recover(dir, schema, nodeId, recoverOpts(ctx));
}

const commands = {
  // Build a validated parameter package.
  pack(args, ctx) {
    const defs = readJson(args.def);
    const values = args.values ? readJson(args.values) : {};
    const safeSet = args['safe-set'] ? readJson(args['safe-set']) : {};
    const schema = compileSchema(defs);
    const probe = new ParamStore(schema, 'pack');
    for (const [k, v] of Object.entries(safeSet)) {
      const def = schema.params.get(k);
      if (!def) throw new ParamSyncError('VALIDATION', `safe-set: unknown key '${k}'`);
      probe.validateValue(def, v);
    }
    for (const [k, v] of Object.entries(values)) probe.set(k, v);
    const pack = { format: 'param-sync-pack/1', defs, values, safeSet };
    const out = JSON.stringify(pack, null, 2) + '\n';
    if (args.out) fs.writeFileSync(args.out, out);
    else ctx.stdout(out);
  },

  // Apply a pack to a local db directory.
  apply(args, ctx) {
    const pack = readJson(args.pack);
    const schema = compileSchema(pack.defs);
    writeSchema(args.db, pack.defs);
    const { store: ps } = PersistentStore.recover(args.db, schema, 'dispatch', recoverOpts(ctx));
    if (pack.safeSet && Object.keys(pack.safeSet).length > 0) {
      ps.commitSafeSet(pack.safeSet);
    }
    for (const [k, v] of Object.entries(pack.values || {})) ps.set(k, v);
    const snap = ps.commitSnapshot();
    ctx.stdout(JSON.stringify({ applied: Object.keys(pack.values || {}), seq: snap.seq }) + '\n');
  },

  // Record an actual (feedback) value read back from the controller.
  feedback(args, ctx) {
    if (args.def && !readSchema(args.db)) writeSchema(args.db, readJson(args.def));
    const { store: ps } = loadDb(args.db, 'feedback', ctx);
    const value = JSON.parse(args.value);
    ps.set(args.key, value);
    ps.commitSnapshot();
    ctx.stdout(JSON.stringify({ recorded: { [args.key]: value } }) + '\n');
  },

  // Merge dispatch db and feedback db via version vectors.
  sync(args, ctx) {
    const defs = readSchema(args.dispatch);
    if (!defs) throw new ParamSyncError('VALIDATION', 'dispatch db has no schema.json');
    const schema = compileSchema(defs);
    const a = PersistentStore.recover(args.dispatch, schema, 'dispatch', recoverOpts(ctx)).store.store.snapshot();
    const b = PersistentStore.recover(args.feedback, schema, 'feedback', recoverOpts(ctx)).store.store.snapshot();
    const { merged, pending } = mergeSnapshots(schema, a, b);
    const out = JSON.stringify({ merged, pending }, null, 2) + '\n';
    if (args.out) fs.writeFileSync(args.out, out);
    else ctx.stdout(out);
    if (pending.length > 0) {
      ctx.stderr(JSON.stringify({
        error: { code: 'SYNC_PENDING', message: `${pending.length} safety-critical conflict(s) pending`, details: { pending } },
      }) + '\n');
      return EXIT_CODES.SYNC_PENDING;
    }
    return 0;
  },

  // Ordered rollback: unlock -> revert -> cert-clear.
  rollback(args, ctx) {
    const { store: ps } = loadDb(args.db, 'dispatch', ctx);
    const certs = loadCerts(args.db);
    const engine = new RollbackEngine(ps.store, certs);
    const stateFile = rollbackStatePath(args.db);
    if (fs.existsSync(stateFile)) {
      const st = readJson(stateFile);
      engine.phaseIndex = st.phaseIndex;
      engine.done = st.done;
    }
    const snapshot = args.snapshot ? readJson(args.snapshot) : ps.store.snapshot();
    const save = () => {
      ps.commitSnapshot();
      saveCerts(args.db, certs);
      if (engine.phaseIndex >= 3) fs.rmSync(stateFile, { force: true });
      else fs.writeFileSync(stateFile, JSON.stringify({ phaseIndex: engine.phaseIndex, done: engine.done }));
    };
    if (args.all) {
      const result = engine.runAll(snapshot);
      save();
      ctx.stdout(JSON.stringify(result) + '\n');
      return 0;
    }
    const phase = args.phase;
    let result;
    if (phase === 'unlock') result = { unlocked: engine.unlock() };
    else if (phase === 'revert') result = { reverted: engine.revert(snapshot) };
    else if (phase === 'cert-clear') result = { certsCleared: engine.certClear() };
    else throw new ParamSyncError('VALIDATION', `unknown phase '${phase}'`);
    save();
    ctx.stdout(JSON.stringify(result) + '\n');
    return 0;
  },

  // Certificate management.
  cert(args, ctx) {
    const sub = args._[0];
    const cs = loadCerts(args.db);
    if (sub === 'issue') {
      const c = cs.issue(args.id, args.subject ?? '');
      saveCerts(args.db, cs);
      ctx.stdout(JSON.stringify({ issued: c }) + '\n');
    } else if (sub === 'revoke') {
      cs.revoke(args.id);
      saveCerts(args.db, cs);
      ctx.stdout(JSON.stringify({ revoked: args.id }) + '\n');
    } else if (sub === 'clear') {
      const n = cs.clear();
      saveCerts(args.db, cs);
      ctx.stdout(JSON.stringify({ cleared: n }) + '\n');
    } else if (sub === 'list') {
      ctx.stdout(JSON.stringify({ certs: cs.list() }) + '\n');
    } else {
      throw new ParamSyncError('VALIDATION', `unknown cert subcommand '${sub}'`);
    }
    return 0;
  },
};

// Programmatic entry: returns an exit code instead of calling process.exit.
// io: { stdout, stderr, env } — all optional.
export function runCli(argv, io = {}) {
  const ctx = {
    stdout: io.stdout ?? ((s) => process.stdout.write(s)),
    stderr: io.stderr ?? ((s) => process.stderr.write(s)),
    env: io.env ?? process.env,
  };
  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  if (!cmd || !commands[cmd]) {
    ctx.stderr(JSON.stringify({
      error: { code: 'USAGE', message: `usage: param-sync <${Object.keys(commands).join('|')}> [options]` },
    }) + '\n');
    return 64;
  }
  try {
    return commands[cmd](args, ctx) ?? 0;
  } catch (err) {
    if (err instanceof ParamSyncError) {
      ctx.stderr(JSON.stringify({ error: err.toJSON() }) + '\n');
      return EXIT_CODES[err.code] ?? 1;
    }
    ctx.stderr(JSON.stringify({ error: { code: 'INTERNAL', message: err.message } }) + '\n');
    return 1;
  }
}
