# stratlog

一个 TypeScript 实现的分层否定 Datalog 推理库（仅依赖 Node.js 内置模块，零 npm 依赖）：

- **编译期分层检查**：构建谓词依赖图，用 Tarjan SCC 检测**含否定边的依赖环**，
  拒绝时抛出 `UnstratifiedError` 并给出**完整环路径**（如 `q -[not]-> p -[not]-> q`）。
- **按层求最小模型**：合法程序按 stratum 自底向上做半朴素（semi-naive）不动点求值，
  否定字面量只引用已完成的更低层，得到最小模型。
- **来源（provenance）**：每条推导事实记录其全部有效推导（规则 + 正/负前件），
  通过 `explain(fact)` 查询。
- **增量维护**：`insert` / `retract` 基于 provenance 做 DRed 式删除级联 +
  重推导。撤回事实时精确级联其支持的推导；被否定阻塞的规则在事实消失后重新触发；
  新事实出现时，依赖其"不存在"的旧否定推导会被失效——**不会遗留过时的否定推导**。
- **有限常量域**：编译期做安全性检查（头部/否定变量必须出现在正体字面量中），
  保证有限域上求值终止。

## 语言

```prolog
edge(a, b).                              % 事实（EDB）
reach(X) :- start(X).                    % 规则
reach(Y) :- reach(X), edge(X, Y).
unreach(X) :- node(X), not reach(X).     % 分层否定（也支持 \+）
```

变量以大写字母或 `_` 开头；常量为数字、小写符号或 `'字符串'`；`%` 为行注释。

## API

```ts
import { InferenceDB } from "stratlog";

const db = new InferenceDB();
db.load(`
  node(a). node(b). node(c).
  edge(a, b). start(a).
  reach(X) :- start(X).
  reach(Y) :- reach(X), edge(X, Y).
  unreach(X) :- node(X), not reach(X).
`);

db.factsOf("unreach");        // ["unreach(b)", "unreach(c)"]
db.explain("reach(b)");       // { base: false, derivations: [{ rule: "reach(Y) :- ...",
                              //   positive: ["reach(a)", "edge(a,b)"], negative: [] }] }
db.layers();                  // { edge: 0, node: 0, start: 0, reach: 1, unreach: 2 }

db.retract("edge(a, b)");     // 增量撤回：reach(b) 消失，unreach(b) 出现
db.insert("edge(a, b)");      // 增量插入：unreach(b) 被清除（无残留否定推导）
```

## 实现要点

- `src/parser.ts` — 递归下降解析器（事实 / 规则 / `not` 否定）。
- `src/compile.ts` — 安全性与元数检查；依赖图 + Tarjan SCC；SCC 内含否定边即拒绝，
  并在 SCC 内 DFS 出具体环路径；按"正边同层、负边升层"计算 stratum。
- `src/engine.ts` — 每层半朴素不动点求值；推导记录正/负前件并建立反向依赖索引；
  删除沿正依赖级联、插入沿负依赖级联，随后逐层重推导至不动点。
  层内求值只增不减；每层结束后失效该层新事实的负依赖，保证高层无过时否定推导。

## 测试

```sh
npm test    # tsc 编译 + node:test 运行
```

测试覆盖：分层接受/拒绝（含环路径）、按层最小模型、provenance 内容、
撤回/再插入不遗留旧否定推导、多推导冗余支持，以及 **120 步确定性随机
插入/撤回序列，每步都将增量结果（模型 + 全部 provenance）与完整重算逐一对比**。

### 实际运行结果（Node v22.22.1）

```
rejected cycle: Unstratifiable program: negative dependency cycle: q -[not]-> p -[not]-> q
120 random insert/retract ops; model + provenance match full recompute after every op
final model size: 19 facts, base: 12

# tests 13
# suites 5
# pass 13
# fail 0
# duration_ms ~90-170ms
```

13/13 通过，包括随机序列每步与完整重算的模型及来源一致性对照。
