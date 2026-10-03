#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { GuaranteeChain, GuaranteeError } from './guarantee-chain.js';

const USAGE = `Usage: node src/cli.js [--data DIR] <command> [options]

Commands:
  issue   --id ID [--parent ID] --exposure N --cap N --expires-at ISO [--terms TEXT]
  revoke  --id ID
  expire  --id ID [--now ISO]
  purge   --id ID [--now ISO]
  show    --id ID
  list
  phrase  <phrase...>
  near    <termA> <termB> --k N
  audit   --id ID [--phrase TEXT | --near-a A --near-b B --k N]
  verify

Data directory defaults to $GUARANTEE_DATA or ./guarantee-data.`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i++;
      } else {
        opts[key] = true;
      }
    } else {
      opts._.push(arg);
    }
  }
  return opts;
}

function execute(argv) {
  const opts = parseArgs(argv);
  const command = opts.help ? 'help' : opts._.shift();
  if (!command || command === 'help') {
    return { code: command ? 0 : 1, stdout: USAGE };
  }
  const dataDir = opts.data ?? process.env.GUARANTEE_DATA ?? './guarantee-data';
  const chain = GuaranteeChain.load({ dataDir });
  const out = (value) => ({ code: 0, stdout: JSON.stringify(value, null, 2) });

  switch (command) {
    case 'issue':
      return out(chain.issue({
        id: opts.id,
        parentId: opts.parent ?? null,
        exposure: Number(opts.exposure),
        cap: Number(opts.cap),
        terms: opts.terms ?? '',
        expiresAt: opts['expires-at'],
      }));
    case 'revoke':
      return out(chain.revoke(opts.id));
    case 'expire':
      return out(chain.expire(opts.id, opts.now ?? new Date()));
    case 'purge':
      return out(chain.purge(opts.id, opts.now ?? new Date()));
    case 'show': {
      const rec = chain.get(opts.id);
      if (!rec) throw new GuaranteeError('NOT_FOUND', `guarantee ${opts.id} does not exist`);
      return out(rec);
    }
    case 'list':
      return out(chain.list());
    case 'phrase':
      return out(chain.queryPhrase(opts._.join(' ')));
    case 'near':
      return out(chain.queryNear(opts._[0], opts._[1], Number(opts.k)));
    case 'audit': {
      let query = null;
      if (opts.phrase) query = { phrase: opts.phrase };
      else if (opts['near-a'] !== undefined) {
        query = { near: { terms: [opts['near-a'], opts['near-b']], k: Number(opts.k) } };
      }
      return out(chain.audit(opts.id, query));
    }
    case 'verify':
      return out(chain.verify());
    default:
      return { code: 1, stderr: `unknown command: ${command}\n${USAGE}` };
  }
}

export function run(argv) {
  try {
    return execute(argv);
  } catch (err) {
    const message = err instanceof GuaranteeError
      ? `error ${err.code}: ${err.message}`
      : `error: ${err.message}`;
    return { code: 1, stderr: message };
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const result = run(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}
