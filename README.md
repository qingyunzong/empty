# stratlog

一个带否定（stratified negation）的 Datalog 推理库：TypeScript 编写，仅使用
Node.js 内置模块，零运行时依赖。

- **编译期否定环拒绝**：构建谓词依赖图（Tarjan SCC），任何否定边落在同一
  SCC 内即拒绝，并在错误信息中给出完整的负依赖环路径（如
  `negative dependency cycle a -> b -> c -> d -> a`）。
- **按层求最小模型**：对 SCC 凝聚图做最长路径分层，自下而上逐层半朴素
  （semi-naive）求值至不动点，得到分层最小模型；否定字面量只引用已求值
  完毕的更底层。
- **事实撤回的增量更新**：插入/撤回 EDB 事实时做 DRed 式维护——先沿溯源
  图过度删除（over-delete，正确处理 `p(X) :- p(X).` 这类循环支撑），再只
  对受影响层按升序重导出。被撤回事实重新满足的 `not` 会产生新推导；重新
  为真的事实会撤销旧的否定推导，不留陈旧结论。
- **完整重算对照**：`recompute()` 从空状态完整重算，作为预言机（oracle）；
  差分测试在随机分层程序 + 随机增删序列的每一步之后，比较增量维护与完整
  重算的**模型与全部溯源**（`snapshot()`），二者必须完全一致。
- **溯源**：每条推导记录规则、正向支撑事实与负向支撑原子
  （`why(pred, ...args)`）。

## 使用

```ts
import { Engine } from "./src/engine.js";

const eng = new Engine();
eng.addRules(`
  reachable(X) :- start(X).
  reachable(Y) :- reachable(X), edge(X, Y).
  blocked(X) :- node(X), not reachable(X).
`);
eng.addFact("node", "a");
eng.addFact("start", "a");
eng.addFact("edge", "a", "b");

eng.query("blocked");          // 不在 reachable 中的节点
eng.why("blocked", "c");       // 该结论的推导（规则 + 正/负支撑）
eng.retractFact("edge", "a", "b"); // 增量撤回，blocked 集合随之更新
eng.recompute();               // 完整重算（对照用）
eng.snapshot();                // { model, provenance } 可比较快照
```

语法：变量以大写字母或 `_` 开头；小写标识符为符号常量；支持数字与双引号
字符串常量；`%` 为行注释。规则要求范围限制（safety）：头部与否定字面量中
的变量必须出现在某个正向体字面量中。

## 结构

- `src/core.ts` — 项/原子/规则模型、键与溯源记录
- `src/parser.ts` — 规则文本解析
- `src/compile.ts` — 安全检查、依赖图、负环检测（含路径）、分层
- `src/engine.ts` — 分层半朴素求值、溯源索引、DRed 增量维护、完整重算
- `test/` — 编译期（9）、求值（7）、增量（13）、随机差分（2）共 31 个测试

## 测试

```sh
npm test          # tsc 编译后运行 node --test
DIFF_PROGRAMS=1000 DIFF_OPS=50 npm test   # 加大差分测试规模
```

## 实际测试结果

环境：Node.js v22.22.1，TypeScript 7.0.2（tsc 仅作编译器，无运行时依赖）。

```
$ npm test
ok 1 - build/test/compile.test.js        (9 个测试：分层/负环路径/安全/元数)
ok 2 - build/test/differential.test.js   (2 个测试：40 程序×25 步随机差分、重算幂等)
ok 3 - build/test/eval.test.js           (7 个测试：最小模型/分层否定/溯源)
ok 4 - build/test/incremental.test.js    (13 个测试：撤回级联/陈旧否定清除/循环支撑)
# tests 4  # pass 4  # fail 0
```

差分测试另以 `DIFF_PROGRAMS=1000 DIFF_OPS=50`（1000 个随机分层程序、每个
50 步随机增删、每步对照完整重算的模型与溯源）验证通过；随机程序 100%
含否定规则。该扫描曾暴露循环自支撑推导在撤回后残留的问题，已通过
DRed 过度删除修复并加入回归测试。

记录时间：2026-10-05T14:34:13Z（UTC）。
