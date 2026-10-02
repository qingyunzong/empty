'use strict';

const { Engine } = require('./engine');

function referenceRun(messages, options = {}) {
  const engine = new Engine(options);
  const ordered = [...messages].sort((x, y) => {
    if (x.authId !== y.authId) return x.authId < y.authId ? -1 : 1;
    return x.seq - y.seq;
  });
  for (const msg of ordered) engine.ingest(msg);
  return engine.report();
}

module.exports = { referenceRun };
