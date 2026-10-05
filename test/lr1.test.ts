import { test } from "node:test";
import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import process from "node:process";

import { parseGrammar, MAX_PRODUCTIONS } from "../src/grammar.js";
import {
  CanonicalLR1,
  computeFirst,
  findConflicts,
  shortestPath,
  analyzeLalrMerge,
  followPath,
} from "../src/lr1.js";
import { verifyItemSets } from "../src/verify.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "..", "src", "cli.js");
const examplesDir = join(here, "..", "..", "examples");

const ELSE_GRAMMAR = `
S -> i S e S
S -> i S
S -> a
`;

const LALR_NOT_LR1 = `
S -> A a
S -> b A c
S -> B c
S -> b B a
A -> d
B -> d
`;

// 本沙箱中 node 子进程的 stdio 管道不可靠（stdout 丢失、stdin 挂起），
// 因此 CLI 集成测试通过 shell 重定向到临时文件来捕获输入输出。
let tmpCounter = 0;
function runCli(args: string[], stdinText?: string) {
  const id = `${process.pid}-${tmpCounter++}`;
  const outFile = `/tmp/lr1-cli-${id}.out`;
  const errFile = `/tmp/lr1-cli-${id}.err`;
  const quote = (a: string) => `'${a.replace(/'/g, "'\\''")}'`;
  let cmd = `${quote(process.execPath)} ${[cliPath, ...args].map(quote).join(" ")}`;
  if (stdinText !== undefined) {
    const inFile = `/tmp/lr1-cli-${id}.in`;
    writeFileSync(inFile, stdinText);
    cmd += ` < ${quote(inFile)}`;
  }
  cmd += ` > ${quote(outFile)} 2> ${quote(errFile)}`;
  const r = spawnSync("sh", ["-c", cmd], { encoding: "utf8" });
  return {
    status: r.status ?? -1,
    stdout: readFileSync(outFile, "utf8"),
    stderr: readFileSync(errFile, "utf8"),
  };
}

test("解析：备选分支、注释、空产生式", () => {
  const g = parseGrammar("S -> A a | b # comment\nA -> c | eps\n");
  // augmented + 4 user productions
  assert.equal(g.productions.length, 5);
  assert.equal(g.productions[0]!.lhs, "S'");
  assert.deepEqual(g.productions[4]!.rhs, []); // eps -> epsilon
  assert.ok(g.nonterminals.has("S") && g.nonterminals.has("A"));
  assert.ok(g.terminals.has("a") && g.terminals.has("b") && g.terminals.has("c"));
  assert.ok(!g.terminals.has("A"));
});

test("解析：超过 20 条产生式报错", () => {
  const text = Array.from({ length: MAX_PRODUCTIONS + 1 }, (_, i) => `S -> a${i}`).join("\n");
  assert.throws(() => parseGrammar(text), /上限/);
  const ok = Array.from({ length: MAX_PRODUCTIONS }, (_, i) => `S -> a${i}`).join("\n");
  assert.equal(parseGrammar(ok).productions.length, MAX_PRODUCTIONS + 1);
});

test("FIRST 集（含 ε）", () => {
  const g = parseGrammar("S -> A B\nA -> a | eps\nB -> b\n");
  const first = computeFirst(g);
  assert.deepEqual([...first.get("A")!].sort(), ["", "a"]);
  assert.ok(first.get("S")!.has("a") && first.get("S")!.has("b"));
  assert.ok(!first.get("S")!.has(""));
});

test("悬挂 else：恰好 1 个移入-归约冲突，最短路径 i i S", () => {
  const g = parseGrammar(ELSE_GRAMMAR);
  const auto = new CanonicalLR1(g);
  const conflicts = findConflicts(g, auto.states, auto.transitions);
  assert.equal(conflicts.length, 1);
  const c = conflicts[0]!;
  assert.equal(c.kind, "shift-reduce");
  assert.equal(c.lookahead, "e");
  assert.ok(c.shiftTo !== null);
  assert.equal(c.reduceProds.length, 1);
  assert.deepEqual(g.productions[c.reduceProds[0]!]!.rhs, ["i", "S"]);

  // 规范 LR(1) 中冲突只出现在嵌套 if 的内层状态：i i S
  const path = shortestPath(auto.transitions, c.stateId);
  assert.deepEqual(path, ["i", "i", "S"]);
  // 路径确实从初态到达冲突状态
  assert.equal(followPath(auto.transitions, path), c.stateId);
});

test("二义表达式文法：报告冲突且路径可达", () => {
  const g = parseGrammar("E -> E + E\nE -> E * E\nE -> ( E )\nE -> id\n");
  const auto = new CanonicalLR1(g);
  const conflicts = findConflicts(g, auto.states, auto.transitions);
  assert.ok(conflicts.length >= 2, `期望至少 2 个冲突，实际 ${conflicts.length}`);
  assert.ok(conflicts.every((c) => c.kind === "shift-reduce"));
  const las = new Set(conflicts.map((c) => c.lookahead));
  assert.ok(las.has("+") && las.has("*"));
  for (const c of conflicts) {
    const path = shortestPath(auto.transitions, c.stateId);
    assert.equal(followPath(auto.transitions, path), c.stateId);
  }
});

test("规范 LR(1) 无冲突，但 LALR 合并引入冲突（不算原冲突）", () => {
  const g = parseGrammar(LALR_NOT_LR1);
  const auto = new CanonicalLR1(g);
  const conflicts = findConflicts(g, auto.states, auto.transitions);
  assert.equal(conflicts.length, 0, "规范 LR(1) 不应有冲突");

  const lalr = analyzeLalrMerge(auto);
  assert.ok(lalr.mergedStateCount < auto.states.length, "LALR 合并应减少状态数");
  // 合并 {A->d·, B->d·} 同心状态后，在 a 和 c 上各引入一个归约-归约冲突
  assert.equal(lalr.introducedConflicts.length, 2);
  assert.ok(lalr.introducedConflicts.every((c) => c.kind === "reduce-reduce"));
  assert.deepEqual(
    lalr.introducedConflicts.map((c) => c.lookahead).sort(),
    ["a", "c"]
  );
});

test("无二义表达式文法：无冲突，LALR 也不引入冲突", () => {
  const g = parseGrammar("E -> E + T\nE -> T\nT -> T * F\nT -> F\nF -> ( E )\nF -> id\n");
  const auto = new CanonicalLR1(g);
  assert.equal(findConflicts(g, auto.states, auto.transitions).length, 0);
  assert.equal(analyzeLalrMerge(auto).introducedConflicts.length, 0);
});

test("前缀枚举核对项目集：悬挂 else 文法", () => {
  const g = parseGrammar(ELSE_GRAMMAR);
  const auto = new CanonicalLR1(g);
  const r = verifyItemSets(auto, { maxPrefixLen: 4, maxFormLen: 9 });
  assert.ok(r.comparedPrefixes >= 10, `比较的前缀数过少：${r.comparedPrefixes}`);
  assert.deepEqual(r.mismatches, []);
  assert.ok(r.ok);
});

test("前缀枚举核对项目集：含 ε 的文法", () => {
  const g = parseGrammar("S -> A a B\nA -> b A | eps\nB -> c\n");
  const auto = new CanonicalLR1(g);
  const r = verifyItemSets(auto, { maxPrefixLen: 4, maxFormLen: 9 });
  assert.ok(r.comparedPrefixes >= 10, `比较的前缀数过少：${r.comparedPrefixes}`);
  assert.deepEqual(r.mismatches, []);
  assert.ok(r.ok);
});

test("前缀枚举核对项目集：LALR 反例文法", () => {
  const g = parseGrammar(LALR_NOT_LR1);
  const auto = new CanonicalLR1(g);
  const r = verifyItemSets(auto, { maxPrefixLen: 4, maxFormLen: 9 });
  assert.deepEqual(r.mismatches, []);
  assert.ok(r.ok);
});

test("CLI：从文件读取并报告冲突与最短路径", () => {
  const r = runCli([join(examplesDir, "else.txt")]);
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("1 个移入-归约冲突"));
  assert.ok(r.stdout.includes("最短符号路径：i i S"));
  assert.ok(r.stdout.includes("归约 S -> i S"));
});

test("CLI：LALR 引入的冲突单独报告，不计入原冲突", () => {
  const r = runCli([join(examplesDir, "lalr-not-lr1.txt")]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("未发现冲突"));
  assert.ok(r.stdout.includes("合并引入 2 个冲突（不计入上述原冲突）"));
});

test("CLI：标准输入 + --verify", () => {
  const r = runCli(["--verify"], ELSE_GRAMMAR);
  assert.equal(r.status, 1, `stderr: ${r.stderr}`);
  assert.ok(r.stdout.includes("前缀枚举核对：通过"));
});

test("CLI：超过 20 条产生式退出码为 2", () => {
  const text = Array.from({ length: 21 }, (_, i) => `S -> a${i}`).join("\n");
  const r = runCli([], text);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("上限"));
});
