# settlement-judge

日终清算判定器：给定一批来自不同柜面的命令历史（JSONL），判定是否存在一个
**拓扑 / 区间一致的串行调度**，使得每个账户的可用额从不为负、冻结/扣款/释放/结算
语义全部成立。输出 `SAT` 及一个 witness 顺序，或 `UNSAT` 及最小冲突子集。

运行环境：Node.js 22，仅标准库，单机离线，不开线程、不联网。测试使用 `node:test`。

## 用法

```sh
node bin/judge.js <history.jsonl> [--explain out.json]
# 或链接后直接使用
judge <history.jsonl> --explain out.json
```

- 标准输出打印判定结果；`--explain` 将机器可读的判定结果写入 JSON 文件。
- 退出码：

| 退出码 | 含义 |
| ------ | ---- |
| 0      | SAT（存在可串行化调度），stdout 打印 witness |
| 1      | UNSAT（不存在），stdout 打印最小冲突子集 |
| 12     | 区间非法（`start`/`end` 非有限数或 `start > end`） |
| 13     | `depends` 存在环（含自依赖） |
| 14     | 未知/非法命令（未知 action、JSON 解析失败、缺字段、重复 opId、depends 指向不存在的 opId 等） |
| 2      | 用法错误（参数缺失、输入文件不可读） |

校验按行进行，先报出的行级错误优先；跨命令检查顺序为：重复 opId / 悬空
depends（14）→ depends 环（13）。

## 输入格式

每行一个 JSON 对象：

```json
{"opId":"f1","session":"s1","start":0,"end":2,"action":"FREEZE","account":"A","amount":50,"balance":100,"depends":[]}
```

- `opId`（必填）：命令标识，全局唯一；字典序比较按字符串（UTF-16 码元）。
- `session`（可选）：柜面会话标识，仅作元数据，不参与约束。
- `start` / `end`（必填）：命令的时间区间，须为有限数且 `start <= end`。
- `action`（必填）：`FREEZE` | `DEBIT` | `RELEASE` | `SETTLE`。
- `account`（必填）：账户标识。
- `amount`（必填）：正有限数。
- `depends`（可选，默认 `[]`）：必须先完成的 opId 列表。
- `balance`（可选）：声明该账户的初始可用额；同一账户多次声明时取文件序首个，
  未声明的账户初始可用额为 0，初始冻结额恒为 0。

## 判定语义

**账户状态**：每账户维护 `{available, frozen, hasFreeze}`。各动作的可执行条件与效果：

| 动作 | 前置条件 | 效果 |
| ---- | ---- | ---- |
| `FREEZE a` | `available >= a` | `available -= a; frozen += a; hasFreeze = true` |
| `DEBIT a` | `frozen >= a`（对冻结额扣款，冻结不足则失败） | `frozen -= a` |
| `RELEASE a` | `frozen >= a`（释放不超额） | `frozen -= a; available += a` |
| `SETTLE a` | 对应账户已存在 `FREEZE` 且 `frozen >= a` | `frozen -= a` |

任意时刻 `available` 与 `frozen` 不得为负。

**顺序约束**：

- `depends`：依赖的命令必须先于当前命令完成。
- 区间一致：若 `a.end <= b.start` 且非 `b.end <= a.start`，则 `a` 必须先于 `b`
  （区间不相交时保持时间先后；同一瞬时点的零长区间互不约束）。

**输出**：

- `SAT`：返回字典序最小的合法串行顺序（opId 序列）作为 witness。
- `UNSAT`：返回最小冲突子集——按基数最小、同基数按排序后 opId 元组字典序最小
  确定的不可满足子集。子集在**完整历史声明的账户初始余额**下评估；指向子集外
  命令的 depends 边被忽略。

## 独立参考实现

`src/judge.js` 导出 `bruteForce(commands)`：对 `n <= 8` 的历史枚举全部 `n!`
排列并逐一模拟验证，返回字典序最小的合法排列。测试中与主求解器
（按字典序分支的回溯搜索 `solve()`）逐项对照，SAT/UNSAT 结论与 witness
完全一致。

## 库接口

```js
import { parseHistory, judge, solve, minimalConflict, bruteForce } from './src/judge.js';

const commands = parseHistory(jsonlText);   // 校验失败抛 JudgeError（含 exit code）
const outcome = judge(commands);            // {result:'SAT',witness} | {result:'UNSAT',conflict}
```

## 真实运行记录

```console
$ node bin/judge.js examples/interleave.jsonl --explain /tmp/e1.json
SAT witness: f1 d1 r1 t1            # exit=0
$ node bin/judge.js examples/unsat-debit.jsonl --explain /tmp/e2.json
UNSAT conflict: d1                  # exit=1（冻结不足导致 DEBIT 失败）
$ node bin/judge.js examples/unsat-freeze.jsonl
UNSAT conflict: f1 f2               # exit=1（累计冻结超出余额，负可用额）
$ node bin/judge.js examples/cycle.jsonl
judge: depends cycle: a -> b -> a   # exit=13
$ node bin/judge.js examples/bad-interval.jsonl
judge: line 1: invalid interval [5, 2]   # exit=12
$ node bin/judge.js examples/unknown.jsonl
judge: line 1: unknown action "HOLD"     # exit=14
```

失败样例（`--explain` 输出）：

```json
{"result": "UNSAT", "conflict": ["f1", "f2"]}
{"result": "ERROR", "code": 13, "message": "depends cycle: a -> b -> a"}
```

## 测试

```console
$ node --test
ok 1 - test/judge.test.js
# pass 1
# fail 0
$ node test/judge.test.js   # 展开子测试
# tests 27
# pass 27
# fail 0
```

覆盖：可串行化交织返回 witness；冻结不足导致 DEBIT 失败；depends 环（13）与
负可用额（UNSAT）分别报告；并列 witness 取字典序最小；区间非法（12）与未知
命令（14）；SETTLE/RELEASE 规则；最小冲突子集的最小性与字典序平局；以及
`n <= 8` 的随机历史与暴力排列枚举参考实现的逐项对照（含 n=8 定点用例）。
