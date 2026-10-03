'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'quota-freeze-'));
}

function independentUsed(requests, id) {
  const byId = new Map(requests.map((req) => [req.id, req]));
  const walk = (nodeId) => {
    const node = byId.get(nodeId);
    if (node === undefined || node.state !== 'active') return 0;
    let total = node.amount;
    for (const candidate of requests) {
      if (candidate.parentId === nodeId) total += walk(candidate.id);
    }
    return total;
  };
  return walk(id);
}

module.exports = { makeDir, independentUsed };
