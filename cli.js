#!/usr/bin/env node
'use strict';

// 用法: node cli.js [input.json]   （省略文件参数时从 stdin 读取）
// 输入: { "H": "10", "commands": [ {"op": "addRule", ...}, ... ] }
// 输出: JSON 数组，每条命令一个结果

const fs = require('node:fs');
const { Scheduler } = require('./src/scheduler');

function readInput() {
  const file = process.argv[2];
  const text = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
  return JSON.parse(text);
}

function run(spec) {
  const scheduler = new Scheduler();
  const H = spec.H === undefined ? '0' : spec.H;
  const results = [];

  for (const cmd of spec.commands || []) {
    try {
      switch (cmd.op) {
        case 'addRule':
          results.push({ ok: true, op: cmd.op, ...scheduler.addRule(cmd) });
          break;
        case 'updateRule':
          results.push({ ok: true, op: cmd.op, ...scheduler.updateRule(cmd.id, cmd.patch || cmd) });
          break;
        case 'addReservation':
          results.push({ ok: true, op: cmd.op, ...scheduler.addReservation(cmd) });
          break;
        case 'enumerate':
          results.push({ ok: true, op: cmd.op, instances: scheduler.enumerate(cmd.rule, cmd.H !== undefined ? cmd.H : H) });
          break;
        case 'check':
          results.push({ ok: true, op: cmd.op, ...scheduler.checkReservation(cmd.reservation, cmd.H !== undefined ? cmd.H : H) });
          break;
        case 'checkAll':
          results.push({ ok: true, op: cmd.op, results: scheduler.checkAll(cmd.H !== undefined ? cmd.H : H) });
          break;
        case 'overrideChain':
          results.push({ ok: true, op: cmd.op, chain: scheduler.overrideChain(cmd.reservation) });
          break;
        case 'undo':
          results.push({ ok: true, op: cmd.op, applied: scheduler.undo() });
          break;
        case 'redo':
          results.push({ ok: true, op: cmd.op, applied: scheduler.redo() });
          break;
        case 'reservation': {
          const r = scheduler.getReservation(cmd.id);
          results.push({ ok: true, op: cmd.op, reservation: r || null });
          break;
        }
        default:
          results.push({ ok: false, op: cmd.op, error: `未知操作: ${cmd.op}` });
      }
    } catch (err) {
      results.push({ ok: false, op: cmd.op, error: err.message });
    }
  }
  return results;
}

if (require.main === module) {
  const spec = readInput();
  process.stdout.write(JSON.stringify(run(spec), null, 2) + '\n');
}

module.exports = { run };
