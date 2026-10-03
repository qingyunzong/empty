#!/usr/bin/env node
'use strict';

const { Engine, EngineError } = require('./src/engine');

function run(argv, write) {
  const out = write ?? ((s) => process.stdout.write(s));
  const fail = (code, message) => {
    out(JSON.stringify({ error: code, message }) + '\n');
    return 1;
  };

  const [eventJson, workdir] = argv;
  if (!eventJson || !workdir) {
    return fail('USAGE', 'usage: node cli.js <event-json> <workdir>');
  }
  let event;
  try {
    event = JSON.parse(eventJson);
  } catch {
    return fail('INVALID_JSON', 'event argument is not valid JSON');
  }
  try {
    const engine = new Engine(workdir);
    const certificate = engine.apply(event);
    out(JSON.stringify(certificate) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof EngineError) {
      return fail(err.code, err.message);
    }
    return fail('INTERNAL', err && err.message ? err.message : String(err));
  }
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run };
