#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { parseArgs } = require('node:util');
const lib = require('./src/index.js');

function die(msg, code = 1) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

function loadStore(path) {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    die('cannot load store: ' + err.message);
  }
}

function saveStore(path, store) {
  fs.writeFileSync(path, JSON.stringify(store, null, 2) + '\n');
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd) die('usage: cli.js <build|prove_reach|prove_nonreach|verify|locate> [options]');

  if (cmd === 'build') {
    const { values } = parseArgs({
      args: rest,
      options: {
        nodes: { type: 'string' },
        edges: { type: 'string' },
        graph: { type: 'string' },
        store: { type: 'string', default: 'store.json' },
      },
    });
    let nodes;
    let edges;
    if (values.graph) {
      const g = JSON.parse(fs.readFileSync(values.graph, 'utf8'));
      nodes = g.nodes || [];
      edges = g.edges || [];
    } else {
      nodes = values.nodes ? JSON.parse(values.nodes) : [];
      edges = values.edges ? JSON.parse(values.edges) : [];
    }
    const store = lib.build(nodes, edges);
    saveStore(values.store, store);
    process.stdout.write(store.version + '\n');
    return;
  }

  if (cmd === 'prove_reach' || cmd === 'prove_nonreach') {
    const { values } = parseArgs({
      args: rest,
      options: {
        store: { type: 'string', default: 'store.json' },
        s: { type: 'string' },
        t: { type: 'string' },
        ttl: { type: 'string' },
        out: { type: 'string' },
      },
    });
    if (values.s === undefined || values.t === undefined) die('missing --s or --t');
    const store = loadStore(values.store);
    const opts = {};
    if (values.ttl !== undefined) opts.ttlMs = Number(values.ttl) * 1000;
    const prove = cmd === 'prove_reach' ? lib.prove_reach : lib.prove_nonreach;
    const res = prove(store, values.s, values.t, opts);
    if (!res.ok) {
      process.stdout.write(res.code + '\n');
      process.exit(1);
    }
    saveStore(values.store, store);
    const json = JSON.stringify(res.cert, null, 2) + '\n';
    if (values.out) {
      fs.writeFileSync(values.out, json);
      process.stdout.write(res.cert.proof_id + '\n');
    } else {
      process.stdout.write(json);
    }
    return;
  }

  if (cmd === 'verify') {
    const { values } = parseArgs({
      args: rest,
      options: {
        store: { type: 'string', default: 'store.json' },
        proof: { type: 'string' },
      },
    });
    if (!values.proof) die('missing --proof');
    const store = loadStore(values.store);
    let proof;
    try {
      proof = JSON.parse(fs.readFileSync(values.proof, 'utf8'));
    } catch (err) {
      die('cannot load proof: ' + err.message);
    }
    const result = lib.verify(store, proof);
    process.stdout.write(result + '\n');
    process.exit(result === lib.VALID ? 0 : 1);
    return;
  }

  if (cmd === 'locate') {
    const { values } = parseArgs({
      args: rest,
      options: {
        store: { type: 'string', default: 'store.json' },
        sources: { type: 'string' },
        t: { type: 'string' },
      },
    });
    if (!values.sources || !values.t) die('missing --sources or --t');
    const store = loadStore(values.store);
    const res = lib.locate_contamination(store, values.sources.split(','), values.t);
    if (!res.ok) {
      process.stdout.write(res.code + '\n');
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(res) + '\n');
    return;
  }

  die('unknown command: ' + cmd);
}

main();
