#!/usr/bin/env node
import { Archive, ArchiveError } from './archive.js';
import { Querier } from './query.js';

const USAGE = `usage: shift-archive <command> --archive DIR [options]

commands:
  append  --ts N --device NAME --tokens "a b c"   append event to active segment
  freeze                                          freeze active segment
  merge   --from N --to N                         merge frozen segments in window (atomic)
  retain  --before N                              tombstone events with ts < N
  query   --phrase "a b c" | --near A,B,K         query across all segments
  stats                                           archive statistics

error codes: E_WINDOW E_MERGE E_RETAIN`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new ArchiveError('E_WINDOW', `unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const eq = key.indexOf('=');
    if (eq >= 0) {
      flags[key.slice(0, eq)] = key.slice(eq + 1);
    } else {
      flags[key] = rest[++i];
    }
  }
  return { cmd, flags };
}

function num(flags, name) {
  const v = flags[name];
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (!cmd || !flags.archive) {
    console.error(USAGE);
    process.exit(2);
  }
  const archive = new Archive(flags.archive);
  switch (cmd) {
    case 'append': {
      const event = archive.append({ ts: num(flags, 'ts'), device: flags.device, tokens: flags.tokens ?? '' });
      console.log(JSON.stringify(event));
      break;
    }
    case 'freeze': {
      console.log(JSON.stringify(archive.freeze()));
      break;
    }
    case 'merge': {
      console.log(JSON.stringify(archive.merge(num(flags, 'from'), num(flags, 'to'))));
      break;
    }
    case 'retain': {
      console.log(JSON.stringify(archive.retain(num(flags, 'before'))));
      break;
    }
    case 'query': {
      const querier = new Querier(archive);
      let hits;
      if (flags.phrase !== undefined) {
        hits = querier.phrase(flags.phrase);
      } else if (flags.near !== undefined) {
        const parts = String(flags.near).split(',');
        if (parts.length !== 3) throw new ArchiveError('E_WINDOW', '--near expects A,B,K');
        hits = querier.near(parts[0], parts[1], Number(parts[2]));
      } else {
        console.error(USAGE);
        process.exit(2);
      }
      for (const hit of hits) console.log(JSON.stringify(hit));
      break;
    }
    case 'stats': {
      console.log(JSON.stringify(archive.stats(), null, 2));
      break;
    }
    default:
      console.error(USAGE);
      process.exit(2);
  }
}

try {
  main();
} catch (err) {
  if (err instanceof ArchiveError) {
    console.error(`${err.code}: ${err.message}`);
    process.exit(1);
  }
  throw err;
}
