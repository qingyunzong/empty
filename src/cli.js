// CLI 逻辑（可进程内调用，便于测试）：schedule / verify
// 退出码：0 成功；1 INFEASIBLE / OVER_BUDGET / 计划校验失败；2 词法/语法/类型/IO 错误（带行列）
import { readFileSync, writeFileSync } from 'node:fs';
import { Session } from './session.js';
import { LangError } from './lexer.js';
import { buildPlan, verifyPlan } from './plan.js';

const r6 = (x) => Math.round(x * 1e6) / 1e6;

function cmdSchedule(args) {
  let file = null;
  let json = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--json') {
      json = args[i + 1];
      if (!json) return { code: 2, stdout: '', stderr: 'error: --json 需要输出路径\n' };
      i += 1;
    } else if (file === null) {
      file = args[i];
    } else {
      return { code: 2, stdout: '', stderr: `error: 多余参数 ${args[i]}\n` };
    }
  }
  if (!file) return { code: 2, stdout: '', stderr: 'usage: energy-sched schedule <site.dsl> [--json plan.json]\n' };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { code: 2, stdout: '', stderr: `error: 无法读取 ${file}: ${e.message}\n` };
  }
  const session = new Session();
  try {
    session.load(text, file);
  } catch (e) {
    if (e instanceof LangError) {
      return { code: 2, stdout: '', stderr: `${file}:${e.line}:${e.col}: error: ${e.message}\n` };
    }
    throw e;
  }
  const result = session.solve();
  if (result.status === 'INFEASIBLE') {
    if (json) writeFileSync(json, `${JSON.stringify({ version: 1, status: 'INFEASIBLE' }, null, 2)}\n`);
    return { code: 1, stdout: 'INFEASIBLE\n', stderr: '' };
  }
  const plan = buildPlan(session.spec, result);
  if (json) writeFileSync(json, `${JSON.stringify(plan, null, 2)}\n`);
  if (result.status === 'OVER_BUDGET') {
    const parts = [`minCost=${r6(result.cost)}`];
    if (session.spec.budgets.cost != null) parts.push(`costBudget=${r6(session.spec.budgets.cost)}`);
    parts.push(`carbon=${r6(result.carbon)}`);
    if (session.spec.budgets.carbon != null) parts.push(`carbonBudget=${r6(session.spec.budgets.carbon)}`);
    return { code: 1, stdout: `OVER_BUDGET ${parts.join(' ')}\n`, stderr: '' };
  }
  return {
    code: 0,
    stdout: `FEASIBLE cost=${r6(result.cost)} peak=${r6(result.peak)} carbon=${r6(result.carbon)}\n`,
    stderr: '',
  };
}

function cmdVerify(args) {
  const file = args[0];
  if (!file) return { code: 2, stdout: '', stderr: 'usage: energy-sched verify <plan.json>\n' };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    return { code: 2, stdout: '', stderr: `error: 无法读取 ${file}: ${e.message}\n` };
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (e) {
    let line = 1;
    let col = 1;
    const m = /position (\d+)/.exec(e.message);
    if (m) {
      const pre = text.slice(0, Number(m[1]));
      const lines = pre.split('\n');
      line = lines.length;
      col = lines[lines.length - 1].length + 1;
    }
    return { code: 2, stdout: '', stderr: `${file}:${line}:${col}: error: 无效的 JSON: ${e.message}\n` };
  }
  const { ok, errors } = verifyPlan(plan);
  if (ok) return { code: 0, stdout: 'OK\n', stderr: '' };
  return { code: 1, stdout: '', stderr: errors.map((e) => `INVALID: ${e}\n`).join('') };
}

export function runCli(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'schedule') return cmdSchedule(rest);
  if (cmd === 'verify') return cmdVerify(rest);
  return { code: 2, stdout: '', stderr: 'usage: energy-sched <schedule|verify> ...\n' };
}
