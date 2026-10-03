#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AlarmIndex } from './src/index.js';

// Programmatic entry: returns an exit code, emits lines via io callbacks.
export function main(argv, io = { stdout: console.log, stderr: console.error }) {
  const [cmd, ...args] = argv;
  const need = (value, what) => {
    if (value === undefined || value === '') throw new Error(`missing argument: ${what}`);
    return value;
  };
  try {
    switch (cmd) {
      case 'build': {
        const dir = need(args[0], 'dir');
        new AlarmIndex().save(dir);
        io.stdout(`initialized empty index at ${dir}`);
        return 0;
      }
      case 'index': {
        const dir = need(args[0], 'dir');
        const files = args.slice(1);
        if (files.length === 0) throw new Error('missing argument: file');
        const idx = AlarmIndex.load(dir);
        for (const file of files) {
          const id = path.basename(file).replace(/\.[^.]*$/, '');
          idx.addDocument(id, fs.readFileSync(file, 'utf8'));
          io.stdout(`indexed ${id}`);
        }
        idx.save(dir);
        return 0;
      }
      case 'del': {
        const dir = need(args[0], 'dir');
        const ids = args.slice(1);
        if (ids.length === 0) throw new Error('missing argument: docId');
        const idx = AlarmIndex.load(dir);
        for (const id of ids) {
          idx.deleteDocument(id);
          io.stdout(`deleted ${id}`);
        }
        idx.save(dir);
        return 0;
      }
      case 'compact': {
        const dir = need(args[0], 'dir');
        const idx = AlarmIndex.load(dir);
        const cert = idx.compact();
        idx.save(dir);
        io.stdout(JSON.stringify(cert, null, 2));
        return 0;
      }
      case 'query': {
        const dir = need(args[0], 'dir');
        const q = need(args.slice(1).join(' '), 'query');
        const idx = AlarmIndex.load(dir);
        for (const r of idx.query(q)) {
          io.stdout(`${r.docId}\thits=${r.hits}\tspan=${r.minSpan}`);
        }
        return 0;
      }
      case 'cert': {
        const dir = need(args[0], 'dir');
        const idx = AlarmIndex.load(dir);
        idx.verifyCert();
        io.stdout(JSON.stringify(idx.certs, null, 2));
        io.stdout('certificate chain OK');
        return 0;
      }
      default:
        io.stderr('usage: node cli.js <build|index|del|compact|query|cert> <dir> [args...]');
        return 2;
    }
  } catch (err) {
    const code = err && typeof err.code === 'string' && err.code.startsWith('E_')
      ? err.code
      : 'E_INTERNAL';
    io.stderr(`${code}: ${err.message}`);
    return 1;
  }
}

const invokedAsScript = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) {
  process.exit(main(process.argv.slice(2)));
}
