#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { MarginCallEngine, SimulatedCrash } from './src/engine.js';

export function main(argv, io = { stdout: (s) => process.stdout.write(s), stderr: (s) => process.stderr.write(s) }) {
  const error = (message) => {
    io.stderr(JSON.stringify({ error: message }) + '\n');
    return 1;
  };

  const [eventArg, logDir] = argv;
  if (!eventArg || !logDir) {
    return error('usage: node cli.js <event-json|event-json-file> <log-dir>');
  }

  let event;
  try {
    const raw =
      fs.existsSync(eventArg) && fs.statSync(eventArg).isFile()
        ? fs.readFileSync(eventArg, 'utf8')
        : eventArg;
    event = JSON.parse(raw);
  } catch (err) {
    return error(`invalid event JSON: ${err.message}`);
  }

  let engine;
  try {
    engine = new MarginCallEngine(logDir);
  } catch (err) {
    return error(`cannot open log directory: ${err.message}`);
  }

  for (;;) {
    try {
      const result = engine.run(event);
      io.stdout(JSON.stringify(result, null, 2) + '\n');
      return 0;
    } catch (err) {
      if (err instanceof SimulatedCrash) {
        engine = new MarginCallEngine(logDir);
        continue;
      }
      return error(err.message);
    }
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
