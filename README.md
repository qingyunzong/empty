# serializability-judge

日终清算判定器：判断一批来自不同柜面的命令历史是否存在**可解释的串行化顺序**，
尤其在冻结（FREEZE）与扣款（DEBIT）交织时。纯 Node.js 22 标准库实现，无第三方依赖，
不开线程、不访问网络。

## 使用

```bash
node judge <history.jsonl> [--explain out.json] [--balance account=amount ...]
# 或（已 chmod +x）
./judge examples/interleave.jsonl --explain out.json
```

判定本身（SAT / UNSAT）退出码均为 0；输入错误使用下列退出码：

| 退出码 | 含义 |
| ------ | ---- |
| 0      | 判定完成（SAT 或 UNSAT） |
| 2      | 用法 / IO / JSON 格式错误 |
| 12     | 区间非法（start/end 非数值或 start > end） |
| 13     | depends 存在环 |
| 14     | 未知命令（未知 action、depends 指向不存在的 opId、opId 重复） |

校验顺序：先区间（12），再未知命令（14），最后 depends 环（13）。

## 输入格式

每行一个 JSON 对象（JSONL）。首行可选声明各账户初始可用额：

```json
{"type":"init","balances":{"accA":100,"accB":50}}
```

其后每行一条命令：

```json
{"opId":"c1","session":"s1","start":1,"end":4,"action":"FREEZE","account":"accA","amount":30,"depends":["c0"]}
```

字段：`opId`（唯一标识）、`session`（冻结会话，DEBIT 可为 null）、`start`/`end`
（命令执行的时间区间）、`action`（FREEZE|DEBIT|RELEASE|SETTLE）、`account`、
`amount`（非负数值）、`depends`（必须先完成的 opId 列表，可省略）。

初始余额也可用 `--balance accA=100` 从命令行补充（覆盖文件中的同名账户）。

## 判定语义

一个串行调度（全部命令的排列）合法，当且仅当：

1. **区间一致**：若 `A.end <= B.start`（区间不重叠），则 A 必须排在 B 之前；
   区间重叠的命令允许任意交织。
2. **depends 先行**：`depends` 中引用的命令必须先完成。
3. **账户状态机可接受**，按顺序逐条执行：
   - `FREEZE`：可用额 ≥ amount，可用额 -= amount，session 冻结额 += amount；
   - `DEBIT`：可用额 ≥ amount，可用额 -= amount（**每账户可用额从不为负**；
     冻结占用过多可用额会导致后续 DEBIT 失败）；
   - `RELEASE`：session 冻结额 ≥ amount，冻结额 -= amount，可用额 += amount（不超额）；
   - `SETTLE`：同 session 的 FREEZE 必须已先完成，且 session 冻结额 ≥ amount，
     冻结额 -= amount（资金划走）。

## 输出

- **SAT**：输出字典序最小的 witness 顺序（按 opId 序列比较；多个合法调度并列时取最小）。
- **UNSAT**：输出最小冲突子集——基数最小的仍不可判定的命令子集，并列时按
  排序后 opId 元组的字典序取最小（n ≤ 16 时精确枚举，更大时用确定性的贪心
  极小化近似，见 `src/solver.js`）。

`--explain out.json` 把结果写成 JSON：

```json
{"verdict":"SAT","witness":["c1","c2","c3"]}
{"verdict":"UNSAT","conflict":["c1","c2"]}
```

## 实现结构

- `src/model.js` — JSONL 解析、校验（退出码 12/13/14）、账户状态机
- `src/solver.js` — 回溯搜索（按 opId 升序展开候选，首个完整调度即字典序最小 witness）、最小冲突子集
- `src/brute.js` — 独立参考实现：n ≤ 8 时纯排列枚举（无剪枝），仅与求解器共享状态机
- `src/judge.js` — 判定编排；`src/cli.js` + `judge` — 命令行入口
- `test/judge.test.js` — node:test 测试（含与暴力枚举的逐项对照）

## 测试

最近一次运行（2026-10-04，Node v22.22.1）：

```bash
$ node --test              # 测试入口（按文件聚合）
# tests 1
# pass 1
# fail 0
$ node test/judge.test.js  # 展开全部用例
# tests 19
# pass 19
# fail 0
```

覆盖：可串行化交织返回 witness；并列 witness 取字典序最小；区间顺序约束；
冻结占用过多导致 DEBIT 失败（UNSAT + 最小冲突子集）；负可用额与 depends 环分别报告
（前者 UNSAT 判定、后者退出码 13）；SETTLE 前无 FREEZE；RELEASE 超额；
退出码 12/13/14；200 个随机实例（n ≤ 8）求解器与暴力枚举逐项对照，
并对 UNSAT 实例用暴力法验证冲突子集的极小性。

## 真实命令与样例

SAT（冻结/扣款交织）：

```bash
$ node judge examples/interleave.jsonl --explain out.json
SAT
witness: c1 c2 c3 c4 c5
# out.json: {"verdict":"SAT","witness":["c1","c2","c3","c4","c5"]}
```

失败样例 1 —— 冻结占用过多可用额，DEBIT 必然失败（exit 0，判定 UNSAT）：

```bash
$ cat examples/unsat-debit.jsonl
{"type":"init","balances":{"accA":40}}
{"opId":"c1","session":"s1","start":1,"end":3,"action":"FREEZE","account":"accA","amount":25,"depends":[]}
{"opId":"c2","session":null,"start":2,"end":4,"action":"DEBIT","account":"accA","amount":20,"depends":[]}
$ node judge examples/unsat-debit.jsonl
UNSAT
conflict: c1 c2
```

（无论 c1、c2 谁在前：先 FREEZE 25 则可用额 15 < 20，DEBIT 失败；先 DEBIT 20 则
可用额 20 < 25，FREEZE 失败。）

失败样例 2 —— depends 环（exit 13）：

```bash
$ node judge examples/cycle.jsonl
error: depends cycle: a -> b -> a   # exit=13
```

失败样例 3 —— 区间非法与未知命令（exit 12 / 14）：

```bash
$ node judge examples/bad-interval.jsonl
error: a: invalid interval [5, 2]   # exit=12
$ node judge examples/unknown.jsonl
error: a: depends on unknown command "ghost"   # exit=14
```
