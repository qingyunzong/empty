#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseInstance } from './parse.js';
import { solve, BudgetExceeded, type SolveStats } from './solver.js';
import { exhaustiveOptimum } from './exhaustive.js';
import { renderCertificate, renderLegend, verifyCertificate } from './certificate.js';

const EXHAUSTIVE_AUTO_MAX_CELLS = 24;
const EXHAUSTIVE_AUTO_MAX_RECTS = 7;

function printUsage(): void {
  console.log(`用法: node dist/src/cli.js <input.json> [选项]

选项:
  --exhaustive auto|on|off   极小网格全枚举核对（默认 auto: 格子<=${EXHAUSTIVE_AUTO_MAX_CELLS} 且矩形<=${EXHAUSTIVE_AUTO_MAX_RECTS} 时启用）
  --budget <N>               搜索节点预算（默认 50000000）
  -h, --help                 显示帮助

输入 JSON 格式:
  {
    "grid": { "width": 8, "height": 8, "forbidden": [[3,3],[4,3]] },
    "rectangles": [
      { "id": "r1", "w": 4, "h": 2, "profit": 14, "rotate": true }
    ]
  }
约束: 网格 <= 8x8, 矩形 <= 10 个, rotate 缺省为 false。`);
}

function fail(msg: string, code: number): number {
  console.error(msg);
  return code;
}

export function main(argv: string[]): number {
  let exhaustiveMode: 'auto' | 'on' | 'off' = 'auto';
  let nodeLimit = 50_000_000;
  let input: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-h' || a === '--help') {
      printUsage();
      return 0;
    } else if (a === '--exhaustive') {
      const v = argv[++i];
      if (v === 'auto' || v === 'on' || v === 'off') exhaustiveMode = v;
      else return fail('--exhaustive 取值须为 auto|on|off', 1);
    } else if (a.startsWith('--exhaustive=')) {
      const v = a.slice('--exhaustive='.length);
      if (v === 'auto' || v === 'on' || v === 'off') exhaustiveMode = v;
      else return fail('--exhaustive 取值须为 auto|on|off', 1);
    } else if (a === '--budget') {
      const v = Number(argv[++i]);
      if (!Number.isInteger(v) || v <= 0) return fail('--budget 须为正整数', 1);
      nodeLimit = v;
    } else if (a.startsWith('-')) {
      return fail(`未知选项: ${a}`, 1);
    } else if (input === undefined) {
      input = a;
    } else {
      return fail('只能指定一个输入文件', 1);
    }
  }
  if (input === undefined) {
    printUsage();
    return 1;
  }

  let inst;
  try {
    inst = parseInstance(JSON.parse(readFileSync(input, 'utf8')));
  } catch (e) {
    return fail(`输入无效: ${(e as Error).message}`, 2);
  }

  const { width, height } = inst.grid;
  console.log(`实例: ${width}x${height} 网格, 禁区 ${inst.grid.forbidden.length} 格, 矩形 ${inst.rectangles.length} 个`);

  const stats: SolveStats = { nodes: 0, subsetsTried: 0 };
  const t0 = performance.now();
  let sol;
  try {
    sol = solve(inst, { nodeLimit, stats });
  } catch (e) {
    if (e instanceof BudgetExceeded) return fail(`求解失败: ${e.message}`, 3);
    throw e;
  }
  const ms = performance.now() - t0;

  console.log(
    `求解: ${ms.toFixed(1)} ms, 尝试子集 ${stats.subsetsTried}/${1 << inst.rectangles.length}, 搜索节点 ${stats.nodes}`,
  );
  console.log(`最优收益: ${sol.profit}  总面积: ${sol.area}  放置: ${sol.placements.length}/${inst.rectangles.length}`);
  console.log('占用证书 (#=禁区, .=空格):');
  console.log(renderCertificate(inst, sol));
  console.log('图例:');
  console.log(renderLegend(inst, sol));

  const problems = verifyCertificate(inst, sol);
  if (problems.length === 0) {
    console.log('证书校验: 通过');
  } else {
    console.log(`证书校验: 失败\n  ${problems.join('\n  ')}`);
  }

  const cells = width * height;
  const runExhaustive =
    exhaustiveMode === 'on' ||
    (exhaustiveMode === 'auto' && cells <= EXHAUSTIVE_AUTO_MAX_CELLS && inst.rectangles.length <= EXHAUSTIVE_AUTO_MAX_RECTS);
  if (runExhaustive) {
    const ex = exhaustiveOptimum(inst);
    if (!ex.complete) {
      console.log('全枚举核对: 未完成（超出节点预算）');
    } else if (ex.profit === sol.profit && ex.area === sol.area) {
      console.log(`全枚举核对: 通过（${1 << inst.rectangles.length} 个子集, ${ex.nodes} 节点, 收益/面积一致）`);
    } else {
      console.log(`全枚举核对: 不一致! 枚举最优 收益${ex.profit}/面积${ex.area} vs 求解 收益${sol.profit}/面积${sol.area}`);
      return 4;
    }
  } else {
    console.log('全枚举核对: 跳过（超出极小规模阈值, 可用 --exhaustive on 强制）');
  }

  return problems.length === 0 ? 0 : 5;
}

process.exitCode = main(process.argv.slice(2));
