import { MvccStore, MvccError } from './store.js';

export const USAGE = `usage:
  mvcc commit --db DIR key=value [key2=value2 ...] [--del key ...]
  mvcc read --db DIR [--tag NAME] [key]
  mvcc snapshot --db DIR NAME [SEQ]
  mvcc untag --db DIR NAME
  mvcc tags --db DIR
  mvcc gc --db DIR [--before SEQ]`;

function parseFlags(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (name === 'del') (flags.del ||= []).push(args[++i]);
      else flags[name] = args[++i];
    } else {
      pos.push(a);
    }
  }
  return { flags, pos };
}

// io: { stdout(chunk), stderr(chunk) } — chunks are strings or Buffers.
// Returns the process exit code.
export function runCli(argv, io = { stdout: (c) => process.stdout.write(c), stderr: (c) => process.stderr.write(c) }) {
  const out = (s) => io.stdout(typeof s === 'string' ? s + '\n' : s);
  const errOut = (s) => io.stderr(s + '\n');
  const [cmd, ...rest] = argv;
  const { flags, pos } = parseFlags(rest);
  if (!cmd) {
    errOut(USAGE);
    return 2;
  }
  const dir = flags.db || './mvcc-data';
  const store = MvccStore.open(dir);
  try {
    switch (cmd) {
      case 'commit': {
        const writes = {};
        for (const pair of pos) {
          const eq = pair.indexOf('=');
          if (eq < 0) throw new Error(`expected key=value, got "${pair}"`);
          writes[pair.slice(0, eq)] = pair.slice(eq + 1);
        }
        for (const k of flags.del || []) writes[k] = null;
        const seq = store.commit(writes);
        out(`committed seq=${seq}`);
        break;
      }
      case 'read': {
        const tx = flags.tag !== undefined ? store.beginTag(flags.tag) : store.begin();
        if (pos.length > 0) {
          const v = tx.get(pos[0]);
          if (v === undefined) {
            errOut(`key not found: ${pos[0]}`);
            return 1;
          }
          io.stdout(v);
          io.stdout('\n');
        } else {
          for (const k of tx.keys()) out(`${k}=${tx.get(k).toString('utf8')}`);
        }
        tx.close();
        break;
      }
      case 'snapshot': {
        const name = pos[0];
        if (!name) throw new Error('usage: mvcc snapshot --db DIR NAME [SEQ]');
        const seq = pos[1] !== undefined ? store.tag(name, Number(pos[1])) : store.tag(name);
        out(`tag ${name} -> seq=${seq}`);
        break;
      }
      case 'untag': {
        if (!pos[0]) throw new Error('usage: mvcc untag --db DIR NAME');
        store.untag(pos[0]);
        out(`removed tag ${pos[0]}`);
        break;
      }
      case 'tags': {
        for (const [name, seq] of store.tags()) out(`${name}\t${seq}`);
        break;
      }
      case 'gc': {
        const before = flags.before !== undefined ? Number(flags.before) : null;
        const n = store.gc(before);
        out(`gc collected ${n} version(s)`);
        break;
      }
      default:
        errOut(USAGE);
        return 2;
    }
    return 0;
  } catch (err) {
    if (err instanceof MvccError) {
      errOut(`${err.code}: ${err.message}`);
    } else {
      errOut(`ERROR: ${err.message}`);
    }
    return 1;
  } finally {
    store.close();
  }
}
