#!/usr/bin/env node
// JSONL 命令行接口：stdin 每行一个 JSON 命令，stdout 每行一个 JSON 结果。
// 命令: {"op":"join","node":"n1"} / {"op":"leave","node":"n1"}
//       {"op":"write","key":"temp","value":21.5,"node":"n1"[,"epoch":3]}
//       {"op":"read"[,"key":"temp"]} / {"op":"repair"[,"node":"n4"]}
//       {"op":"isolate","nodes":["n4"]} / {"op":"heal"} / {"op":"members"}
// 错误: {"ok":false,"error":"NOT_MEMBER"|"EPOCH_MISMATCH"|"QUORUM_FAIL",...}
import readline from 'node:readline';
import { Cluster, ClusterError } from './cluster.js';

const cluster = new Cluster();

function handle(cmd) {
  switch (cmd.op) {
    case 'join':
      return cluster.join(cmd.node);
    case 'leave':
      return cluster.leave(cmd.node);
    case 'write': {
      const r = cluster.write({ key: cmd.key, value: cmd.value, node: cmd.node, epoch: cmd.epoch });
      return { epoch: r.epoch, signers: r.signers, vector: r.vector, entry: r.entry };
    }
    case 'read':
      return cluster.read({ key: cmd.key });
    case 'repair':
      return cluster.repair(cmd.node);
    case 'isolate':
      return cluster.isolate(cmd.nodes ?? [cmd.node]);
    case 'heal':
      return cluster.heal();
    case 'members':
      return {
        epoch: cluster.epoch,
        members: [...cluster.members].sort(),
        tombstones: [...cluster.tombstones].sort(),
      };
    default:
      throw new ClusterError('UNKNOWN_OP', `unknown op: ${cmd.op}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const t = line.trim();
  if (!t) continue;
  let out;
  try {
    const cmd = JSON.parse(t);
    out = { ok: true, op: cmd.op, ...handle(cmd) };
  } catch (err) {
    if (err instanceof ClusterError) {
      out = { ok: false, error: err.code, message: err.message };
    } else {
      out = { ok: false, error: 'BAD_COMMAND', message: String(err?.message ?? err) };
    }
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}
