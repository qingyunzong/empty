# clearing-merge

清算所结算批次三方合并工具：把同一批次的基准文件 `base.jsonl`、本行调整
`left.jsonl`、对手行调整 `right.jsonl` 合并为可入账结果，并为审计生成可复核的
冲突证书（sha256）。Node.js 22，仅标准库，测试基于 `node:test`，单机离线运行。

## 记录模型

每行一个 JSON 对象，字段：`id, account, amount, ccy, seq, status`。
`status` 状态机：`DRAFT -> LOCKED -> SETTLED`，禁止回退。

## 使用

```bash
node bin/cli.js merge <base.jsonl> <left.jsonl> <right.jsonl> \
  --out result.jsonl --conflicts conflicts.json
```

- `--out`：合并结果（JSONL，按 `id` 确定性排序）；省略时写到 stdout。
- `--conflicts`：冲突清单（JSON 数组），每项含 `id, rule, base, left, right, sha256`，
  其中 `sha256` 是对该条目（不含 sha256 字段本身）规范化 JSON 的证书哈希。
- 退出码：`0` 成功（允许存在冲突项）；`2` 输入/用法错误。

## 合并规则

| 规则 | 编号 | 判定 |
| --- | --- | --- |
| 金额双改 | `R1` | 两侧都改了 `amount` 且不相等、也都不等于 base |
| 币种双改 | `R2` | 两侧都改了 `ccy` 且无法三方归并 |
| 状态双改 | `R3` | 两侧都改了 `status` 且无法三方归并 |
| 状态回退 | `R4` | 任一侧 `status` 相对 base 逆向迁移（如 `LOCKED -> DRAFT`） |
| 删除-修改 | `R5` | 一侧删除、另一侧相对 base 有修改 |
| 新增冲突 | `R6` | base 不存在，两侧各自新增同一 `id` 且内容不同 |
| 其他字段双改 | `R7` | `account`/`seq` 两侧都改且无法归并 |

单字段三方归并：两侧相等取该值；一侧等于 base 取另一侧；否则冲突。
删除仅在另一侧未改且 base 存在时生效。冲突的 `id` 不落入结果文件。

## 错误输出

坏行、重复 `id`、非法状态迁移目标均以 JSON 行写 stderr，退出码 2：

```bash
$ node bin/cli.js merge bad.jsonl left.jsonl right.jsonl
{"code":"BAD_JSONL","line":2,"msg":"bad.jsonl:2 invalid JSON: Unexpected token 'o', \"not-json\" is not valid JSON"}
$ echo $?
2
```

错误码：`BAD_JSONL`（坏行/非对象/缺 id）、`DUP_ID`（重复 id）、
`INVALID_STATUS`（非法状态值）、`READ_ERROR`（文件不可读）。

## 真实运行示例

`examples/` 下有一份样例批次（id=1 干净合并，id=2 金额双改，id=3 状态回退，
id=4 删除-修改）：

```bash
$ cd examples
$ node ../bin/cli.js merge base.jsonl left.jsonl right.jsonl --out result.jsonl --conflicts conflicts.json
merged: 1 record(s), 3 conflict(s)
```

`result.jsonl`（按 id 排序，仅干净记录落账）：

```json
{"id":1,"account":"ACC-001","amount":1250,"ccy":"USD","seq":1,"status":"LOCKED"}
```

`conflicts.json` 摘要（完整文件含 base/left/right 三方摘要）：

| id | rule | 说明 | sha256（前 12 位） |
| --- | --- | --- | --- |
| 2 | `R1` | 金额 3400 被两侧分别改为 3000/3600 | `d551b5cefdf1` |
| 3 | `R4` | 状态 `LOCKED -> DRAFT` 回退 | `b52f181b0477` |
| 4 | `R5` | 左侧删除、右侧改币种为 JPY | `570bf2595a56` |

## 测试

```bash
node --test
```

覆盖验收点：

1. 无冲突合并与确定性排序（`test/merge.test.js`）。
2. 金额双改冲突且不落入结果。
3. 状态回退冲突与删除-修改冲突。
4. 对 n<=8 的随机小集做暴力校验：独立 oracle 枚举单字段变更/删除/新增，
   与合并结果逐条对照（1000+ 用例），并校验每条冲突的 sha256 证书。
5. CLI 端到端：干净合并、冲突证书、坏行/重复 id/非法状态的
   `{code,line,msg}` 与退出码 2（`test/cli.test.js`）。

## 结构

- `lib/merge.js`：解析、三方合并、冲突证书、确定性排序。
- `bin/cli.js`：`merge` 子命令 CLI。
- `test/`：`node:test` 全量测试。
- `examples/`：可复现的样例输入与输出。
