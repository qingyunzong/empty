# credit-freeze-hist

券商盘中系统的离线信用账户冻结判定：在（可能分叉的）历史事件日志上，
判定某一历史时刻 `asOf(ts, seq)` 是否应冻结信用账户，并给出触发规则与最小解释集合。

- 运行环境：Node.js 22，仅标准库，测试用 `node:test`，离线单机。
- 库：`index.js`；CLI：`cli.js`；示例日志：`examples/hist.jsonl`。

## 事件日志格式（JSONL）

每行一个 JSON 对象（空行与 `#` 开头的行被忽略）。公共字段：

| 字段 | 说明 |
| --- | --- |
| `ts` | 事件时间（数值，>= 0），必填 |
| `seq` | 同一 `ts` 内的序号（数值，>= 0），必填；同一 `ts` 按 `seq` 排序 |
| `op` | 操作类型，见下 |
| `branch` | 所属分支，缺省为 `main` |

操作：

| op | 额外字段 | 语义 |
| --- | --- | --- |
| `rule` | `id`, 可选 `group` | 定义/重新激活风险规则；带 `group` 时规则继承交易组，仅作用于组内账户 |
| `revoke` | `rule` | 撤销规则：规则自该点起失效；若账户正因该规则冻结则解冻。撤销仅影响之后，不回溯历史 |
| `join` | `group`, 可选 `account` | 账户加入交易组 |
| `trigger` | `rule`, 可选 `account` | 触发规则：规则当前有效且作用于该账户时冻结账户 |
| `fork` | `branches` | 从 `branch`（父分支）分叉出新分支，子分支继承父分支当前全部状态 |
| `merge` | `sources` | 把源分支并入 `branch`（目标分支）：取两分支可见事件并集，冲突状态按 **deny 优先**（任一侧冻结则冻结） |

## 查询语义

`asOf(ts, seq)` 只考虑 `(ts, seq)` 不晚于该点的事件，更晚的事件（含 fork/merge）完全忽略。
同一 `ts` 内按 `seq` 升序重放；`seq` 也相同则按文件行序。查询默认分支 `main`、默认账户 `default`。

输出：

```json
{
  "asOf": "10:3",
  "branch": "main",
  "account": "default",
  "frozen": true,
  "rule": "R1",
  "explanation": [ { "line": 1, "ts": 10, "seq": 1, "op": "rule", "id": "R1" }, ... ]
}
```

- `frozen`：布尔判定结果。
- `rule`：触发冻结的规则 id（未冻结为 `null`）。
- `explanation`：最小解释集合——冻结时为 规则定义 (+入组) + 触发 + 携带该状态的 merge 事件链；
  曾冻结但被撤销时为 触发链 + 撤销事件；从未触发为空数组。

## 错误码

所有错误退出码为 1，stderr 形如 `E_FORK: ...`：

| 码 | 含义 |
| --- | --- |
| `E_TIME` | 事件 `ts`/`seq` 非法，或 `--as-of` 缺失/格式错误（应为 `ts:seq`） |
| `E_FORK` | 分支结构错误：分叉重名、合并未知分支、自分并入自身、未知分支上的事件或查询 |
| `E_PARSE` | JSON 解析失败、未知 op、缺字段 |
| `E_IO` / `E_USAGE` | 文件不可读 / 命令行用法错误 |

## 用法

```bash
# 库
node -e "const {parseLog,evaluate}=require('./index.js');
const evs=parseLog(require('fs').readFileSync('examples/hist.jsonl','utf8'));
console.log(evaluate(evs,{asOf:'5:2'}));"

# CLI
node cli.js examples/hist.jsonl --as-of 10:3
node cli.js examples/hist.jsonl --as-of 5:2 --branch desk-a --account default

# 测试
node --test        # 或 npm test
```

## 文件

- `index.js` — 库：`parseLog` / `parseAsOf` / `evaluate` / `HistError`
- `cli.js` — 命令行入口（同时导出 `run(args)` 便于进程内测试）
- `test/hist.test.js` — 验收 1–3：同 ts 不同 seq 边界、撤销前后 asOf 变化、fork/merge deny 优先
- `test/random.test.js` — 验收 4：随机 <=12 分支日志与独立参考重放实现对照（含同 ts 高压用例）
- `test/cli.test.js` — CLI 行为与退出码
- `RESULTS.md` — 测试运行记录
