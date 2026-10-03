#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { GuaranteeStore, StoreError } from '../src/store.js';

const USAGE = `chain-guarantee <command> [options]

Commands:
  issue   --parent <id> --exposure <n> --cap <n> --terms <text> --expires <ms|ISO> [--id <id>] [--now <ms>]
  revoke  --id <id> [--now <ms>]
  sweep   [--now <ms>]                      mark due guarantees as expired (logical delete)
  purge   --id <id>                         physical delete of a dead subtree
  phrase  <query text>                      phrase search over live terms
  near    <t1> <t2> [...] [--k <window>]    ordered proximity search
  audit   --id <id> [--query <text>]        occupancy path, remaining caps, hits, chain hash
  show    --id <id>
  list
  verify                                    recompute subtree sums, hashes and index

Global: --data <dir>  (default: env CG_DATA or ./.cgdata)
`;

function parse(argv, options) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
}

const num = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new StoreError('BAD_ARG', `--${name} must be a number, got "${v}"`);
  return n;
};

const expires = (v) => {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new StoreError('BAD_ARG', `bad --expires: "${v}"`);
  return t;
};

// returns process exit code; io defaults to real stdout/stderr
export function run(argv, io) {
  const stdout = io?.stdout ?? ((s) => process.stdout.write(s));
  const stderr = io?.stderr ?? ((s) => process.stderr.write(s));
  try {
    const [command, ...rest] = argv;
    if (!command || command === 'help' || command === '--help') {
      stdout(USAGE);
      return 0;
    }
    const common = {
      data: { type: 'string', default: process.env.CG_DATA ?? './.cgdata' },
      now: { type: 'string' },
    };
    let out;
    switch (command) {
      case 'issue': {
        const { values } = parse(rest, {
          ...common,
          id: { type: 'string' },
          parent: { type: 'string' },
          exposure: { type: 'string' },
          cap: { type: 'string' },
          terms: { type: 'string', default: '' },
          expires: { type: 'string' },
        });
        const store = new GuaranteeStore(values.data);
        out = store.issue({
          id: values.id,
          parentId: values.parent ?? null,
          exposure: num(values.exposure, 'exposure'),
          cap: num(values.cap, 'cap'),
          terms: values.terms,
          expiresAt: expires(values.expires),
          now: values.now !== undefined ? num(values.now, 'now') : undefined,
        });
        break;
      }
      case 'revoke': {
        const { values } = parse(rest, { ...common, id: { type: 'string' } });
        const store = new GuaranteeStore(values.data);
        out = store.revoke(values.id, values.now !== undefined ? num(values.now, 'now') : undefined);
        break;
      }
      case 'sweep': {
        const { values } = parse(rest, common);
        const store = new GuaranteeStore(values.data);
        out = { expired: store.sweep(values.now !== undefined ? num(values.now, 'now') : undefined) };
        break;
      }
      case 'purge': {
        const { values } = parse(rest, { ...common, id: { type: 'string' } });
        const store = new GuaranteeStore(values.data);
        out = { purged: store.purge(values.id) };
        break;
      }
      case 'phrase': {
        const { values, positionals } = parse(rest, common);
        const store = new GuaranteeStore(values.data);
        out = store.phraseQuery(positionals.join(' '));
        break;
      }
      case 'near': {
        const { values, positionals } = parse(rest, { ...common, k: { type: 'string', default: '5' } });
        const store = new GuaranteeStore(values.data);
        out = store.nearQuery(positionals, num(values.k, 'k'));
        break;
      }
      case 'audit': {
        const { values } = parse(rest, { ...common, id: { type: 'string' }, query: { type: 'string' } });
        const store = new GuaranteeStore(values.data);
        out = store.audit(values.id, values.query);
        break;
      }
      case 'show': {
        const { values } = parse(rest, { ...common, id: { type: 'string' } });
        const store = new GuaranteeStore(values.data);
        const a = store.audit(values.id);
        out = { ...store.guarantees.get(values.id), used: a.path.at(-1).used, remaining: a.path.at(-1).remaining };
        break;
      }
      case 'list': {
        const { values } = parse(rest, common);
        const store = new GuaranteeStore(values.data);
        out = [...store.guarantees.values()];
        break;
      }
      case 'verify': {
        const { values } = parse(rest, common);
        const store = new GuaranteeStore(values.data);
        out = store.verify();
        if (!out.ok) throw new StoreError('VERIFY_FAILED', out.problems.join('; '));
        break;
      }
      default:
        throw new StoreError('BAD_COMMAND', `unknown command: ${command}`);
    }
    stdout(JSON.stringify(out, null, 2) + '\n');
    return 0;
  } catch (err) {
    const code = err instanceof StoreError ? err.code : 'INTERNAL';
    stderr(JSON.stringify({ error: code, message: err.message }) + '\n');
    return 1;
  }
}

const invokedAsMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedAsMain) {
  process.exitCode = run(process.argv.slice(2));
}
