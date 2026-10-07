#!/usr/bin/env node
// labelpack CLI.
//
//   labelpack init <dir>
//   labelpack dict <dir> --set '{"gtin":[...],"batch":[...],"workstation":[...]}'
//   labelpack append <dir> (--labels '<json>' | --file <path>) [--auto-dict]
//   labelpack dump <dir>
//   labelpack verify <dir>
//   labelpack blocks <dir>

import fs from 'node:fs';
import { createPack, addDictionary, appendLabels } from './writer.js';
import { dumpLabels, decodePack, readIndex } from './reader.js';
import { PackError } from './errors.js';

function parseArgs(argv) {
  const [command, dir, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--auto-dict') {
      flags.autoDict = true;
    } else if (arg.startsWith('--')) {
      flags[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = rest[++i];
    } else {
      throw new PackError('E_ARG', `unexpected argument ${arg}`);
    }
  }
  return { command, dir, flags };
}

function readJsonSource(flags, key, fileKey) {
  if (flags[key] !== undefined) return JSON.parse(flags[key]);
  if (flags[fileKey] !== undefined) return JSON.parse(fs.readFileSync(flags[fileKey], 'utf8'));
  throw new PackError('E_ARG', `missing --${key} or --${fileKey}`);
}

// Runs one CLI invocation. Returns { code, stdout, stderr } without touching
// the process, so tests can drive it in-process.
export function runCli(argv) {
  try {
    const { command, dir, flags } = parseArgs(argv);
    switch (command) {
      case 'init': {
        createPack(dir);
        return ok({ ok: true, dir });
      }
      case 'dict': {
        const values = flags.set !== undefined ? JSON.parse(flags.set) : readJsonSource(flags, 'values', 'file');
        const dict = addDictionary(dir, values);
        return ok({ ok: true, dictVersion: dict.version, entries: dict.entries.length });
      }
      case 'append': {
        const labels = readJsonSource(flags, 'labels', 'file');
        const result = appendLabels(dir, labels, { autoDict: !!flags.autoDict });
        return ok({ ok: true, ...result });
      }
      case 'dump': {
        const { labels, errors } = dumpLabels(dir);
        return { code: errors.length ? 1 : 0, stdout: json({ labels, errors }), stderr: '' };
      }
      case 'verify': {
        const { labels, errors, index } = decodePack(dir);
        return {
          code: errors.length ? 1 : 0,
          stdout: json({ ok: errors.length === 0, labels: labels.length, blocks: index ? index.length : 0, errors }),
          stderr: '',
        };
      }
      case 'blocks': {
        return ok(readIndex(dir));
      }
      default:
        throw new PackError('E_ARG', `unknown command ${JSON.stringify(command)}`);
    }
  } catch (err) {
    const code = err instanceof PackError ? err.code : 'E_INTERNAL';
    return { code: 2, stdout: '', stderr: json({ ok: false, error: { code, message: err.message } }) };
  }
}

function json(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function ok(value) {
  return { code: 0, stdout: json(value), stderr: '' };
}

// Executable entry point (skipped when imported as a module).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
