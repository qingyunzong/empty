'use strict';

const fs = require('node:fs');
const { Engine, XborderError } = require('./engine');

const USAGE = 'usage: xborder run <events.jsonl> --patch <out.jsonl>';

function fail(code, message) {
  process.stderr.write(JSON.stringify({ code, message }) + '\n');
  return 1;
}

function main(argv) {
  const args = argv.slice(2);
  if (args[0] !== 'run') {
    process.stderr.write(USAGE + '\n');
    return 2;
  }
  const positional = [];
  let patchPath = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--patch') {
      patchPath = args[++i];
    } else if (args[i].startsWith('--')) {
      process.stderr.write(`unknown option: ${args[i]}\n${USAGE}\n`);
      return 2;
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length !== 1 || patchPath === undefined) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }

  let text;
  try {
    text = fs.readFileSync(positional[0], 'utf8');
  } catch (err) {
    return fail('E_IO', `cannot read ${positional[0]}: ${err.message}`);
  }

  const engine = new Engine();
  const patchLines = [];
  const lines = text.split('\n');
  let seq = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    seq += 1;
    let event;
    try {
      event = JSON.parse(line);
    } catch (err) {
      flush(patchPath, patchLines);
      return fail('E_INVALID', `line ${seq}: invalid JSON: ${err.message}`);
    }
    try {
      const { add, remove } = engine.apply(event);
      if (add.length > 0 || remove.length > 0) {
        patchLines.push(JSON.stringify({ seq, add, remove }));
      }
    } catch (err) {
      if (err instanceof XborderError) {
        flush(patchPath, patchLines);
        return fail(err.code, err.message);
      }
      throw err;
    }
  }
  flush(patchPath, patchLines);
  return 0;
}

function flush(patchPath, patchLines) {
  const out = patchLines.length > 0 ? patchLines.join('\n') + '\n' : '';
  if (patchPath === null) {
    process.stdout.write(out);
  } else {
    fs.writeFileSync(patchPath, out);
  }
}

module.exports = { main };
