import fs from 'node:fs';
import { createEngine, EngineError } from './engine.js';

const USAGE = 'usage: xborder run <events.jsonl> --patch <out.jsonl>';

function fail(code, message, exitCode) {
  process.stderr.write(JSON.stringify({ code, message }) + '\n');
  return exitCode;
}

export function runCli(argv) {
  const [command, ...rest] = argv;
  if (command !== 'run') {
    process.stderr.write(USAGE + '\n');
    return 2;
  }
  let eventsPath = null;
  let patchPath = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--patch') {
      patchPath = rest[i + 1];
      i += 1;
    } else if (eventsPath === null) {
      eventsPath = rest[i];
    } else {
      process.stderr.write(USAGE + '\n');
      return 2;
    }
  }
  if (!eventsPath || !patchPath) {
    process.stderr.write(USAGE + '\n');
    return 2;
  }

  let raw;
  try {
    raw = fs.readFileSync(eventsPath, 'utf8');
  } catch (err) {
    return fail('E_IO', `cannot read events file: ${err.message}`, 1);
  }

  let outFd;
  try {
    outFd = fs.openSync(patchPath, 'w');
  } catch (err) {
    return fail('E_IO', `cannot open patch file: ${err.message}`, 1);
  }

  const engine = createEngine();
  const lines = raw.split('\n');
  let eventIndex = 0;
  try {
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      eventIndex += 1;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        throw new EngineError('E_PARSE', `line ${eventIndex}: invalid JSON`);
      }
      const patches = engine.apply(event, eventIndex);
      for (const patch of patches) {
        fs.writeSync(outFd, JSON.stringify(patch) + '\n');
      }
    }
  } catch (err) {
    if (err instanceof EngineError) {
      return fail(err.code, err.message, 1);
    }
    throw err;
  } finally {
    fs.closeSync(outFd);
  }
  return 0;
}
