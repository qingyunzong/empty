#!/usr/bin/env node
// 用法: node src/cli.js --state <状态文件.json>
// 标准输入: JSON 命令数组（或 { "commands": [...] }），标准输出: JSON 结果。
// 每条命令是一个事务：应用到内存状态后 commit（临时文件 + rename）成功才算生效；
// commit 失败则回滚内存状态，该命令标记为失败，后续命令基于最后一致状态继续。
// 故障注入（测试用）: 环境变量 TOOLING_FAULT_AT = beforeTempWrite | afterTempWrite | beforeRename
// 进程退出码: 全部成功为 0，任一命令失败为 1，用法错误为 2。
import fs from 'node:fs';
import { ToolingSystem } from './system.js';
import { JsonStore } from './store.js';

function parseArgs(argv) {
  const args = { state: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--state') {
      args.state = argv[i + 1];
      i += 1;
    } else if (argv[i] === '--help') {
      args.help = true;
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.state) {
    process.stderr.write('usage: node src/cli.js --state <state.json>  (commands JSON on stdin)\n');
    process.exitCode = 2;
    return;
  }

  const faultAt = process.env.TOOLING_FAULT_AT;
  const hooks = {};
  if (faultAt) {
    if (!['beforeTempWrite', 'afterTempWrite', 'beforeRename'].includes(faultAt)) {
      throw new Error(`unknown fault point: ${faultAt}`);
    }
    hooks[faultAt] = () => { throw new Error(`simulated crash at ${faultAt}`); };
  }

  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) throw new Error('no commands on stdin');
  const parsed = JSON.parse(raw);
  const commands = Array.isArray(parsed) ? parsed : parsed.commands;
  if (!Array.isArray(commands)) throw new Error('input must be a JSON array of commands');

  const store = new JsonStore(args.state, hooks);
  const system = new ToolingSystem(store.exists() ? store.load() : undefined);

  const results = [];
  let failed = false;
  for (const cmd of commands) {
    const snapshot = structuredClone(system.state);
    try {
      const result = system.command(cmd);
      if (!ToolingSystem.isReadOnly(cmd)) store.commit(system.state);
      results.push({ ok: true, ...result });
    } catch (e) {
      system.state = snapshot; // 内存回滚：无半笔事务
      results.push({ ok: false, error: e.message });
      failed = true;
    }
  }
  process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  process.exitCode = failed ? 1 : 0;
}

try {
  main();
} catch (e) {
  process.stderr.write(`error: ${e.message}\n`);
  process.exitCode = 2;
}
