# clearing-merge

清算所结算批次三方合并工具：把基准文件 `base.jsonl`、本行调整 `left.jsonl`、对手行调整
`right.jsonl` 合并为可入账结果，并为审计产出带 sha256 证书的冲突证据。
仅使用 Node.js 22 标准库，单机离线运行。

## 使用

```bash
node bin/merge.js <base.jsonl> <left.jsonl> <right.jsonl> [--out result.jsonl] [--conflicts conflicts.json]
```

- 每行一条记录，字段：`id, account, amount, ccy, seq, status`。
- 成功（含存在冲突）退出码 0；冲突记录不落入 `result.jsonl`，写入 `conflicts.json`。
- 数据错误（坏 JSONL 行、重复 id、非法状态迁移）退出码 2，stderr 输出 `{"code","line","msg"}`。

## 合并规则

| 规则 | 编号 | 说明 |
| --- | --- | --- |
| 金额冲突 | R1 | 两侧都改且不等、且都不等于 base |
| 币种冲突 | R2 | 同上，作用于 `ccy` |
| 状态冲突 | R3 | 两侧把 `status` 改成不同值 |
| 状态回退 | R4 | 合并结果相对 base 回退（状态机 `DRAFT->LOCKED->SETTLED` 禁止回退） |
| 删除-修改 | R5 | 一侧删除、另一侧修改（删除仅在另一侧未改且 base 存在时生效） |
| 双增不一致 | R6 | 两侧新增同一 id 但内容不同 |
| 其他字段冲突 | R7 | `account`/`seq` 双改不一致 |

字段级三方合并：两侧相等取该值；一侧等于 base 取另一侧；否则冲突。
状态迁移校验：相对 base 一次最多前进一档，跳档（如 `DRAFT->SETTLED`）属于
非法状态迁移，整批失败（exit 2）。输出按 `id` 确定性排序。
每个冲突项包含 base/left/right 摘要、规则编号，以及对规范化摘要的 sha256 证书。

## 真实运行记录

```console
$ node bin/merge.js examples/base.jsonl examples/left.jsonl examples/right.jsonl --out examples/result.jsonl --conflicts examples/conflicts.json
merged=3 conflicts=1 out=examples/result.jsonl conflictsOut=examples/conflicts.json
$ echo $?
0
```

`examples/result.jsonl`（按 id 排序；t004 被 left 删除且 right 未改，删除生效；t005 为 left 新增）：

```jsonl
{"id":"t001","account":"ACC-200","amount":1200,"ccy":"EUR","seq":1,"status":"SETTLED"}
{"id":"t002","account":"ACC-300","amount":300,"ccy":"USD","seq":2,"status":"DRAFT"}
{"id":"t005","account":"ACC-500","amount":42,"ccy":"USD","seq":5,"status":"DRAFT"}
```

`examples/conflicts.json` 摘要：t003 金额双改（base 500 / left 550 / right 999）触发 R1，
证书 `sha256 = 1798aa68cfce0566a6af62730849e4feaee9d9e10683e4c79275f04fe8870d40`。

错误场景（重复 id 与非法状态迁移）：

```console
$ node bin/merge.js examples/base.jsonl dup.jsonl examples/right.jsonl
{"code":"DUP_ID","line":2,"msg":"dup.jsonl:2: duplicate id \"t001\""}
$ echo $?
2
$ node bin/merge.js basej.jsonl leftj.jsonl basej.jsonl   # left 把 DRAFT 直接改 SETTLED
{"code":"ILLEGAL_TRANSITION","line":1,"msg":"id=t009: illegal status transition DRAFT->SETTLED (must advance at most one step)"}
$ echo $?
2
```

## 测试

```console
$ node --test
# 3 个测试文件全部通过：pass 3 / fail 0
# （test/merge.test.js、test/bruteforce.test.js、test/cli.test.js）
```

- `test/merge.test.js`：验收 1–3（无冲突合并与排序、金额双改冲突不落结果、状态回退与删除-修改冲突）及错误路径。
- `test/bruteforce.test.js`：验收 4。固定种子随机生成 n<=8 的记录集，暴力列举全部单字段变更
  （1614 例）、双侧同记录字段/值组合（16710 例）、删除矩阵与新增矩阵，逐例对照合并判定。
- `test/cli.test.js`：CLI 端到端（结果/冲突文件、退出码、stderr 错误格式）。

## 结构

- `src/merge.js` — 三方合并核心（纯函数 `mergeDatasets`，规则编号，sha256 证书）
- `src/jsonl.js` — JSONL 解析与校验（`BAD_JSONL`/`DUP_ID`/`BAD_STATUS`）
- `src/cli.js` — `runCli(argv)`，返回 `{status, stdout, stderr}`，便于进程内测试
- `bin/merge.js` — CLI 入口薄封装
- `examples/` — 上文真实运行所用的输入与产物
