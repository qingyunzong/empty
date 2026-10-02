import fs from 'node:fs';
import { PackError, initPack, openPack } from './pack.js';

const USAGE = `evpack - offline-verifiable research evidence packs

usage: evpack <command> [args]

  init    <dir> --members a,b[,c...]              create an empty pack
  add     <dir> (--data JSON | --jsonl FILE) --member M [--epoch N]
                                                  append evidence block(s); prints result JSON
  prove   <dir> --index N                         print Merkle inclusion proof JSON
  verify  <dir> [--proof FILE] [--digest HEX]     verify whole pack, or one inclusion proof
  digest  <dir>                                   print {epoch, count, heads, digest}
  sync    <dirA> <dirB>                           anti-entropy between two replicas (both ways)
  members <dir> --set a,b[,c...] --member M [--epoch N]
                                                  change membership; raises the epoch barrier

exit codes: 0 ok | 1 error | 2 TAMPER_DETECTED | 3 MISSING_BLOCK |
            4 INVALID_PROOF | 5 STALE_EPOCH | 6 NOT_MEMBER | 7 DIVERGENT
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[i + 1];
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function need(value, message) {
  if (value === undefined || value === true) {
    throw new PackError('ERROR', message);
  }
  return value;
}

function splitMembers(value) {
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function writerOpts(flags) {
  const opts = { member: need(flags.member, '--member is required') };
  if (flags.epoch !== undefined) {
    const epoch = Number(flags.epoch);
    if (!Number.isInteger(epoch) || epoch < 0) throw new PackError('ERROR', '--epoch must be a non-negative integer');
    opts.epoch = epoch;
  }
  return opts;
}

export function run(argv, out = process.stdout) {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;
  const print = (obj) => out.write(JSON.stringify(obj) + '\n');

  switch (command) {
    case 'init': {
      const dir = need(rest[0], 'init requires a directory');
      const pack = initPack(dir, { members: flags.members ? splitMembers(flags.members) : [] });
      print({ ok: true, ...pack.summary() });
      return 0;
    }
    case 'add': {
      const dir = need(rest[0], 'add requires a directory');
      const pack = openPack(dir);
      const opts = writerOpts(flags);
      const added = [];
      if (flags.jsonl !== undefined) {
        const file = need(flags.jsonl, '--jsonl requires a file path');
        const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
        for (const line of lines) {
          added.push(pack.add(JSON.parse(line), opts));
        }
      } else {
        const data = need(flags.data, 'add requires --data JSON or --jsonl FILE');
        added.push(pack.add(JSON.parse(data), opts));
      }
      print({ ok: true, added: added.length, hashes: added.map((b) => b.hash), ...pack.summary() });
      return 0;
    }
    case 'prove': {
      const dir = need(rest[0], 'prove requires a directory');
      const index = Number(need(flags.index, 'prove requires --index N'));
      const pack = openPack(dir);
      print(pack.prove(index));
      return 0;
    }
    case 'verify': {
      const dir = need(rest[0], 'verify requires a directory');
      const pack = openPack(dir);
      if (flags.proof !== undefined) {
        const file = need(flags.proof, '--proof requires a file path');
        const proofObj = JSON.parse(fs.readFileSync(file, 'utf8'));
        print(pack.verifyProof(proofObj, flags.digest));
      } else {
        print(pack.verify());
      }
      return 0;
    }
    case 'digest': {
      const dir = need(rest[0], 'digest requires a directory');
      print(openPack(dir).summary());
      return 0;
    }
    case 'sync': {
      const dirA = need(rest[0], 'sync requires two directories');
      const dirB = need(rest[1], 'sync requires two directories');
      const a = openPack(dirA);
      const b = openPack(dirB);
      const resultA = a.syncFrom(b);
      const resultB = b.syncFrom(a);
      print({ ok: true, a: { dir: dirA, ...resultA }, b: { dir: dirB, ...resultB } });
      return 0;
    }
    case 'members': {
      const dir = need(rest[0], 'members requires a directory');
      const pack = openPack(dir);
      const members = splitMembers(need(flags.set, 'members requires --set a,b,...'));
      const block = pack.setMembers(members, writerOpts(flags));
      print({ ok: true, epochBlock: block.hash, ...pack.summary(), members: pack.members });
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
      out.write(USAGE);
      return command === undefined ? 1 : 0;
    default:
      throw new PackError('ERROR', `unknown command: ${command}`);
  }
}

// In-process entry: returns {code, stdout, stderr} without touching the
// process streams, so tests (and embedders) can drive the CLI directly.
export function runCli(argv) {
  let stdout = '';
  let stderr = '';
  const out = { write: (chunk) => { stdout += chunk; } };
  try {
    const code = run(argv, out);
    return { code, stdout, stderr };
  } catch (err) {
    const isPack = err instanceof PackError;
    const payload = {
      error: {
        code: isPack ? err.code : 'ERROR',
        message: err.message,
        ...(isPack && err.details && Object.keys(err.details).length > 0 ? { details: err.details } : {}),
      },
    };
    stderr = JSON.stringify(payload) + '\n';
    return { code: isPack ? err.exitCode : 1, stdout, stderr };
  }
}

export function main(argv) {
  const { code, stdout, stderr } = runCli(argv);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
