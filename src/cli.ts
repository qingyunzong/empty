// 规范 LR(1) 语法分析 CLI
//
// 用法:
//   node dist/src/cli.js [选项] [文法文件]
//   文法从文件读取；省略文件或传 "-" 时从标准输入读取。
//
// 选项:
//   --states        打印全部规范 LR(1) 状态及项目集
//   --lalr          打印 LALR(1) 合并对照的详细信息
//   --verify=N      前缀枚举核对的最大前缀长度（默认 4）
//   --no-verify     跳过前缀枚举核对
//   --help          显示帮助

import { readFileSync } from "node:fs";
import {
  Grammar,
  MAX_PRODUCTIONS,
  parseGrammar,
  formatProduction,
  formatItem,
} from "./grammar";
import {
  Automaton,
  buildCanonicalLR1,
  findConflicts,
  shortestPaths,
  analyzeLalr,
  Conflict,
} from "./lr1";
import { verifyPrefixes } from "./verify";

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

interface Options {
  file: string | null;
  showStates: boolean;
  showLalr: boolean;
  verifyLen: number | null;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { file: null, showStates: false, showLalr: false, verifyLen: 4, help: false };
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--states") {
      opts.showStates = true;
    } else if (arg === "--lalr") {
      opts.showLalr = true;
    } else if (arg === "--no-verify") {
      opts.verifyLen = null;
    } else if (arg.startsWith("--verify=")) {
      const n = Number(arg.slice("--verify=".length));
      if (!Number.isInteger(n) || n < 0 || n > 12) {
        throw new Error(`--verify 需要 0..12 的整数，收到: ${arg}`);
      }
      opts.verifyLen = n;
    } else if (arg === "--verify") {
      opts.verifyLen = 4;
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`未知选项: ${arg}`);
    } else {
      if (opts.file !== null) throw new Error(`只能指定一个文法文件，收到多余参数: ${arg}`);
      opts.file = arg;
    }
  }
  return opts;
}

const HELP = `规范 LR(1) 语法分析 CLI

用法: node dist/src/cli.js [选项] [文法文件]
  文法从文件读取；省略文件或传 "-" 时从标准输入读取。

文法格式: 每行一条规则，LHS -> alt1 | alt2 | ...
  符号以空白分隔；# 之后为注释；空右部或 ε/eps/epsilon 表示空产生式；
  出现在左部的符号为非终结符；开始符号为第一条规则的左部；
  产生式总数（每个候选式单独计）至多 ${MAX_PRODUCTIONS} 条。

选项:
  --states        打印全部规范 LR(1) 状态及项目集
  --lalr          打印 LALR(1) 合并对照的详细信息
  --verify=N      前缀枚举核对的最大前缀长度（默认 4）
  --no-verify     跳过前缀枚举核对
  --help          显示本帮助`;

function pathLabel(path: string[]): string {
  return path.length === 0 ? "(空)" : path.join(" ");
}

function stateChain(aut: Automaton, path: string[]): string {
  let s = 0;
  const parts = ["0"];
  for (const sym of path) {
    s = aut.transitions[s].get(sym)!;
    parts.push(`-${sym}-> ${s}`);
  }
  return parts.join(" ");
}

/**
 * 运行 CLI。readStdin 仅在未指定文法文件（或文件为 "-"）时调用。
 * 返回退出码与收集到的标准输出/错误文本，便于进程内测试。
 */
export function runCli(argv: string[], readStdin: () => string): CliResult {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const log = (s: string) => outLines.push(s);
  const finish = (code: number): CliResult => ({
    code,
    out: outLines.length === 0 ? "" : outLines.join("\n") + "\n",
    err: errLines.length === 0 ? "" : errLines.join("\n") + "\n",
  });

  let opts: Options;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    errLines.push(`错误: ${(e as Error).message}`);
    return finish(1);
  }
  if (opts.help) {
    log(HELP);
    return finish(0);
  }

  let text: string;
  try {
    if (opts.file === null || opts.file === "-") {
      text = readStdin();
    } else {
      text = readFileSync(opts.file, "utf8");
    }
  } catch (e) {
    errLines.push(`错误: 无法读取输入: ${(e as Error).message}`);
    return finish(1);
  }

  let g: Grammar;
  try {
    g = parseGrammar(text);
  } catch (e) {
    errLines.push(`错误: ${(e as Error).message}`);
    return finish(1);
  }

  log("== 文法 ==");
  log(`开始符号: ${g.start}（增广: ${g.augmentedStart}）`);
  log(`非终结符: ${[...g.nonterminals].join(" ")}`);
  log(`终结符: ${[...g.terminals].join(" ")}`);
  log(`产生式（共 ${g.productions.length - 1} 条，上限 ${MAX_PRODUCTIONS}）:`);
  for (let i = 0; i < g.productions.length; i++) {
    log(`  ${i}. ${formatProduction(g, i)}`);
  }

  const aut = buildCanonicalLR1(g);
  const transitionCount = aut.transitions.reduce((n, m) => n + m.size, 0);
  log("== 规范 LR(1) 自动机 ==");
  log(`状态数: ${aut.states.length}，转移数: ${transitionCount}`);
  log("（未做任何状态合并；LALR 合并引入的冲突不计入原文法冲突。）");

  if (opts.showStates) {
    log("== 规范 LR(1) 状态 ==");
    for (let s = 0; s < aut.states.length; s++) {
      log(`状态 #${s}:`);
      const sorted = [...aut.states[s]].sort(
        (a, b) => a.prod - b.prod || a.dot - b.dot || (a.la < b.la ? -1 : 1)
      );
      for (const it of sorted) {
        log(`  ${formatItem(g, it.prod, it.dot, it.la)}`);
      }
      const trans = [...aut.transitions[s].entries()]
        .map(([sym, tgt]) => `${sym} -> #${tgt}`)
        .join(", ");
      if (trans) log(`  转移: ${trans}`);
    }
  }

  const conflicts = findConflicts(g, aut);
  const paths = shortestPaths(aut);
  log("== 冲突报告（规范 LR(1)）==");
  if (conflicts.length === 0) {
    log("无冲突：该文法是 LR(1) 文法。");
  } else {
    const kindName = (k: string) => (k === "shift-reduce" ? "移入-归约冲突" : "归约-归约冲突");
    conflicts.forEach((c: Conflict, i: number) => {
      log(`冲突 ${i + 1}: 状态 #${c.state}，${kindName(c.kind)}，终结符 \`${c.terminal}\``);
      log(`  最短符号路径: ${pathLabel(paths[c.state])}`);
      log(`  到达链: 状态 ${stateChain(aut, paths[c.state])}`);
      if (c.shiftTarget !== null) {
        log(`  移入动作: 按 \`${c.terminal}\` 移入，转到状态 #${c.shiftTarget}`);
      }
      for (const p of c.reduceProds) {
        log(`  归约动作: 按产生式 ${p}. ${formatProduction(g, p)} 归约`);
      }
      log("  相关项目:");
      for (const it of aut.states[c.state]) {
        const prod = g.productions[it.prod];
        const complete = it.dot === prod.rhs.length;
        const shiftOnC = it.dot < prod.rhs.length && prod.rhs[it.dot] === c.terminal;
        if ((complete && it.la === c.terminal) || shiftOnC) {
          log(`    ${formatItem(g, it.prod, it.dot, it.la)}`);
        }
      }
    });
  }

  const lalr = analyzeLalr(g, aut);
  log("== LALR(1) 合并对照 ==");
  log(`合并后状态数: ${lalr.stateCount}（规范 LR(1) 为 ${aut.states.length}）`);
  const induced = lalr.conflicts.filter((c) => c.mergeInduced);
  if (lalr.conflicts.length === 0) {
    log("LALR(1) 合并后亦无冲突。");
  } else {
    if (opts.showLalr) {
      lalr.conflicts.forEach((c, i) => {
        const tag = c.mergeInduced ? "合并引入（非原文法冲突）" : "原文法冲突";
        const kind = c.kind === "shift-reduce" ? "移入-归约" : "归约-归约";
        log(`  LALR 冲突 ${i + 1}: 合并状态 #${c.state}，${kind}，终结符 \`${c.terminal}\`，${tag}`);
      });
    }
    log(
      `LALR(1) 合并后共 ${lalr.conflicts.length} 个冲突，其中 ${induced.length} 个为合并引入（不计入原文法冲突）。`
    );
  }

  if (opts.verifyLen !== null) {
    log("== 前缀枚举核对 ==");
    const res = verifyPrefixes(g, aut, opts.verifyLen);
    const statusName =
      res.status === "converged" ? "已收敛" : res.status === "exhaustive" ? "达到理论界限" : "被截断";
    log(
      `枚举句型 ${res.formCount} 个（中间形态长度上界 ${res.boundUsed}，${statusName}），` +
        `核对长度 ≤ ${res.maxLen} 的可行前缀 ${res.prefixCount} 个。`
    );
    if (res.status === "truncated") {
      log("警告: 句型数量超出预算，核对不完备。");
    }
    if (res.mismatches.length === 0) {
      log(res.status === "truncated" ? "已核对部分项目集全部一致。" : "所有项目集与自动机状态一致。");
    } else {
      log(`发现 ${res.mismatches.length} 处不一致:`);
      for (const m of res.mismatches) log(`  ${m}`);
      return finish(2);
    }
  }

  return finish(0);
}

// 作为脚本直接运行时：从文件/标准输入读取文法，打印结果并按退出码退出。
if (typeof require !== "undefined" && require.main === module) {
  const res = runCli(process.argv.slice(2), () => readFileSync(0, "utf8"));
  if (res.out) console.log(res.out.replace(/\n$/, ""));
  if (res.err) console.error(res.err.replace(/\n$/, ""));
  process.exitCode = res.code;
}
