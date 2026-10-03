#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { TraceStore, TraceError, EXIT_INPUT_ERROR } = require('./lib');

function parseOp(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new TraceError(`invalid JSON line: ${line}`);
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new TraceError(`invalid op line: ${line}`);
  }
  if (obj.op) return obj;
  if ('edge' in obj) return { op: 'edge', ...obj.edge };
  if ('delEdge' in obj) return { op: 'delEdge', ...obj.delEdge };
  if ('markBad' in obj) {
    const p = obj.markBad;
    return { op: 'markBad', node: typeof p === 'object' ? p.node : p };
  }
  if ('query' in obj) {
    const p = obj.query;
    return { op: 'query', node: typeof p === 'object' ? p.node : p };
  }
  throw new TraceError(`unrecognized op: ${line}`);
}

/** 返回进程退出码；io 可注入便于测试。 */
function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(s));
  const err = io.err || ((s) => console.error(s));
  const file = argv[2];
  if (!file) {
    err('usage: node cli.js trace.jsonl');
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    err(`error: cannot read ${file}: ${e.message}`);
    return 2;
  }
  const store = new TraceStore();
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  try {
    for (const line of lines) {
      const op = parseOp(line);
      switch (op.op) {
        case 'edge':
          store.addEdge(op.from, op.to, op.ver);
          break;
        case 'delEdge':
          store.delEdge(op.from, op.to);
          break;
        case 'markBad':
          store.markBad(op.node);
          break;
        case 'query': {
          const r = store.query(op.node);
          out(JSON.stringify({
            affected: r.affected,
            cert: r.cert,
            coneSize: r.coneSize,
          }) + '\n');
          break;
        }
        default:
          throw new TraceError(`unknown op ${JSON.stringify(op.op)}`);
      }
    }
    return 0;
  } catch (e) {
    if (e instanceof TraceError) {
      err(`error: ${e.message}`);
      return EXIT_INPUT_ERROR;
    }
    throw e;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv);
}

module.exports = { main, parseOp };
