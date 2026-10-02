#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Archive } from './archive.js';
import { recover } from './recover.js';

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        opts[key] = next;
        i += 1;
      } else {
        opts[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, opts };
}

const USAGE = `wxa — append-only bitemporal weather observation archive

usage: wxa <command> [args] [--data <dir>]

  ingest <file.jsonl> [--batch <id>]   append observations (one batch per file)
  correct <batch.json>                 append a correction batch (replace|flag|delete)
  undo <batchId>                       roll back one batch (compensating event)
  query <site> <from> <to>             quality-weighted window aggregate (inclusive)
  audit <site@time>                    version chain + rollback boundary proof
  verify                               re-check hash chain, index and manifest
  recover                              run crash recovery, print the report

data dir: --data, $WXA_DATA, or ./wxa-data`;

// Exported for in-process testing; returns 0 on success, 1 on error.
export async function run(argv, { stdout, stderr, env } = {}) {
  const out = (x) => stdout(`${JSON.stringify(x, null, 2)}\n`);
  const err = (s) => stderr(`error: ${s}\n`);
  const { pos, opts } = parseArgs(argv);
  const [cmd, ...rest] = pos;
  const dir = typeof opts.data === 'string' ? opts.data : env.WXA_DATA ?? './wxa-data';

  try {
  switch (cmd) {
    case 'ingest': {
      if (!rest[0]) throw new Error('ingest: missing <file.jsonl>');
      const archive = await Archive.open(dir);
      const text = await readFile(rest[0], 'utf8');
      const records = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
      out(await archive.ingest(records, { batchId: typeof opts.batch === 'string' ? opts.batch : undefined }));
      break;
    }
    case 'correct': {
      if (!rest[0]) throw new Error('correct: missing <batch.json>');
      const archive = await Archive.open(dir);
      out(await archive.correct(JSON.parse(await readFile(rest[0], 'utf8'))));
      break;
    }
    case 'undo': {
      if (!rest[0]) throw new Error('undo: missing <batchId>');
      const archive = await Archive.open(dir);
      out(await archive.undo(rest[0]));
      break;
    }
    case 'query': {
      if (rest.length < 3) throw new Error('query: missing <site> <from> <to>');
      const archive = await Archive.open(dir);
      out(archive.query(rest[0], rest[1], rest[2]));
      break;
    }
    case 'audit': {
      if (!rest[0]) throw new Error('audit: missing <site@time>');
      const archive = await Archive.open(dir);
      out(archive.audit(rest[0]));
      break;
    }
    case 'verify': {
      const archive = await Archive.open(dir);
      const result = await archive.verify();
      out(result);
      if (!result.ok) return 1;
      break;
    }
    case 'recover': {
      out(await recover(dir));
      break;
    }
    default:
      stderr(`${USAGE}\n`);
      return cmd ? 1 : 0;
  }
  } catch (e) {
    err(e.message);
    return 1;
  }
  return 0;
}

const invokedAs = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedAs) {
  const code = await run(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
    env: process.env,
  });
  process.exitCode = code;
}
