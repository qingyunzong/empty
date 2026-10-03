#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Manifest } from './manifest.js';

export function parseCommands(input) {
  const trimmed = input.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const commands = [];
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (l) commands.push(JSON.parse(l));
    }
    return commands;
  }
}

export function executeCommand(manifest, command) {
  if (!command || typeof command.cmd !== 'string') {
    return { ok: false, error: { code: 'E_CMD', message: 'command object requires a cmd field' } };
  }
  switch (command.cmd) {
    case 'transaction':
      return manifest.commit(command.ops ?? [], command.id);
    case 'rollback':
      return manifest.rollback(command.tx);
    case 'hash':
      return manifest.hash(command.id);
    case 'state':
      return { ok: true, state: manifest.getState() };
    case 'certificate':
      return { ok: true, certificate: manifest.certificate() };
    default:
      return { ok: false, error: { code: 'E_CMD', message: `unknown command '${command.cmd}'` } };
  }
}

export function runCommands(input, options = {}) {
  const manifest = new Manifest(options.builders ? { builders: options.builders } : {});
  let commands;
  try {
    commands = parseCommands(input);
  } catch (err) {
    return { results: [{ ok: false, error: { code: 'E_PARSE', message: `invalid JSON input: ${err.message}` } }], exitCode: 1 };
  }
  const results = commands.map((command) => {
    try {
      return executeCommand(manifest, command);
    } catch (err) {
      return { ok: false, error: { code: 'E_INTERNAL', message: err.message } };
    }
  });
  return { results, exitCode: 0 };
}

export function formatResults(results) {
  return results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : '');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const input = await new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
  const builders = process.env.MANIFEST_BUILDERS ? process.env.MANIFEST_BUILDERS.split(',').filter(Boolean) : undefined;
  const { results, exitCode } = runCommands(input, { builders });
  process.stdout.write(formatResults(results));
  if (exitCode !== 0) process.exit(exitCode);
}
