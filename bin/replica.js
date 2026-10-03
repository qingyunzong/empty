#!/usr/bin/env node
// JSONL command interface: one JSON command per line on stdin,
// one JSON result per line on stdout.
// Batch-oriented: reads stdin to EOF, then emits one result per command.
//
// Commands:
//   {"cmd":"join","node":"n1"}
//   {"cmd":"leave","node":"n1"}
//   {"cmd":"write","node":"n1","key":"temp","value":21.5,"epoch":3}
//   {"cmd":"read","node":"n1","key":"temp","epoch":3}
//   {"cmd":"repair"}
//   {"cmd":"partition","groups":[["n1","n2"],["n3"]]}
//   {"cmd":"heal"}
//   {"cmd":"status"}
import fs from 'node:fs';
import { Cluster, ReplicaError } from '../src/cluster.js';

const cluster = new Cluster();

function dispatch(c) {
  switch (c.cmd) {
    case 'join': return cluster.join(c.node);
    case 'leave': return cluster.leave(c.node);
    case 'write': return cluster.write(c);
    case 'read': return cluster.read(c);
    case 'repair': return cluster.repair();
    case 'partition': cluster.partition(c.groups ?? []); return { epoch: cluster.epoch };
    case 'heal': cluster.heal(); return { epoch: cluster.epoch };
    case 'status': return cluster.status();
    default: {
      const e = new Error(`unknown command: ${c.cmd}`);
      e.code = 'BAD_COMMAND';
      throw e;
    }
  }
}

const input = fs.readFileSync(0, 'utf8');
for (const line of input.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let out;
  try {
    out = { ok: true, result: dispatch(JSON.parse(trimmed)) };
  } catch (err) {
    const code = err instanceof ReplicaError ? err.code : (err.code ?? 'INTERNAL');
    out = { ok: false, error: code, message: err.message };
  }
  fs.writeSync(1, JSON.stringify(out) + '\n');
}
