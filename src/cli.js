#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine, EngineError } from './engine.js';

const INDEX_FILE = 'index.json';

function loadEngine(dir) {
  const file = join(dir, INDEX_FILE);
  if (!existsSync(file)) throw new EngineError('E_CERT', `index not found in ${dir}; run build first`);
  return Engine.fromJSON(JSON.parse(readFileSync(file, 'utf8')));
}

function saveEngine(dir, engine) {
  writeFileSync(join(dir, INDEX_FILE), JSON.stringify(engine.toJSON()));
}

const USAGE = `usage:
  alarm-search build <dir>
  alarm-search index <dir> <docs.jsonl>
  alarm-search del <dir> <docID|extID...>
  alarm-search compact <dir>
  alarm-search query <dir> [--phrase "泵 气蚀"] [--near A B] [--k N] [--json]
  alarm-search cert <dir> [--verify]`;

// Runs one CLI invocation. out/err receive lines without trailing newline.
// Returns the process exit code.
export function runCli(argv, out = console.log, err = console.error) {
  try {
    return dispatch(argv, out, err);
  } catch (e) {
    if (e instanceof EngineError) {
      err(`${e.code}: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

function dispatch(argv, out, err) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'build': {
      const dir = args[0];
      if (!dir) return usage(err);
      mkdirSync(dir, { recursive: true });
      saveEngine(dir, new Engine());
      out(`initialized empty index in ${dir}`);
      return 0;
    }
    case 'index': {
      const [dir, file] = args;
      if (!dir || !file) return usage(err);
      const engine = loadEngine(dir);
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      for (const line of lines) {
        const rec = JSON.parse(line);
        const docID = engine.addDocument(rec.text, rec.id ?? null);
        out(`indexed docID=${docID} ext=${engine.docs.get(docID).ext}`);
      }
      saveEngine(dir, engine);
      return 0;
    }
    case 'del': {
      const [dir, ...ids] = args;
      if (!dir || ids.length === 0) return usage(err);
      const engine = loadEngine(dir);
      for (const id of ids) {
        const docID = engine.deleteDocument(id);
        out(`tombstoned docID=${docID}`);
      }
      saveEngine(dir, engine);
      return 0;
    }
    case 'compact': {
      const dir = args[0];
      if (!dir) return usage(err);
      const engine = loadEngine(dir);
      const cert = engine.compact();
      saveEngine(dir, engine);
      out(JSON.stringify(cert, null, 2));
      return 0;
    }
    case 'query': {
      const dir = args[0];
      if (!dir) return usage(err);
      const opts = { phrase: null, near: null, k: 4 };
      let asJson = false;
      for (let i = 1; i < args.length; i++) {
        if (args[i] === '--phrase') opts.phrase = args[++i];
        else if (args[i] === '--near') opts.near = [args[++i], args[++i]];
        else if (args[i] === '--k') opts.k = Number(args[++i]);
        else if (args[i] === '--json') asJson = true;
        else return usage(err);
      }
      const engine = loadEngine(dir);
      const results = engine.query(opts);
      if (asJson) {
        out(JSON.stringify(results));
      } else {
        for (const r of results) {
          out(`${r.docID}\t${r.ext}\tphraseHits=${r.phraseHits}\tnearHits=${r.nearHits}\tminSpan=${r.minSpan}`);
        }
      }
      return 0;
    }
    case 'cert': {
      const dir = args[0];
      if (!dir) return usage(err);
      const verify = args.includes('--verify');
      const engine = loadEngine(dir);
      if (verify) {
        const cert = engine.verifyCerts();
        out(`OK cert seq=${cert.seq} rootHash=${cert.rootHash}`);
      } else {
        if (engine.certs.length === 0) throw new EngineError('E_CERT', 'no certificate issued yet');
        out(JSON.stringify(engine.certs[engine.certs.length - 1], null, 2));
      }
      return 0;
    }
    default:
      return usage(err);
  }
}

function usage(err) {
  err(USAGE);
  return 2;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  process.exit(runCli(process.argv.slice(2)));
}
