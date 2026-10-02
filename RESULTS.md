# RESULTS

- 日期：2026-10-02T19:35:50Z（UTC）
- 环境：Node.js v22.22.1，仅标准库，离线单机
- 命令：`node --test`（等同 `npm test`）

## 总览

```
$ node --test
✔ test/cli.test.js
✔ test/hist.test.js
✔ test/random.test.js
tests 3 / pass 3 / fail 0        # 文件粒度
```

逐文件子测试（`node <file>` 直跑 TAP 汇总）：

| 文件 | 子测试 | 通过 | 失败 | 覆盖验收点 |
| --- | --- | --- | --- | --- |
| `test/hist.test.js` | 12 | 12 | 0 | 1 同ts不同seq边界；2 撤销前后asOf变化；3 fork/merge deny优先 |
| `test/random.test.js` | 2 | 2 | 0 | 4 随机<=12分支 vs 参考重放（400 种子 + 100 同ts高压种子） |
| `test/cli.test.js` | 6 | 6 | 0 | CLI 判定输出、E_FORK/E_TIME 退出码 1 |
| 合计 | 20 | 20 | 0 | |

## 验收点核对

1. **同 ts 不同 seq 边界**：`acceptance 1` / `1b` —— `asOf 10:1/10:2/10:3` 逐步纳入事件；
   同 ts 内按 seq 而非文件顺序重放（revoke seq 3 先于 trigger seq 5 生效）。
2. **撤销后 asOf 前后变化**：`acceptance 2` / `2b` —— trigger@5、revoke@8：
   `asOf 6:0 → frozen=true`，`asOf 9:0 → frozen=false`；撤销不回溯（`asOf 7:0` 仍冻结），
   撤销后该规则 trigger 不再生效，重新定义后可再次触发。
3. **fork/merge 按 deny**：`acceptance 3` / `3b` / `3c` —— b1 冻结、b2 不冻结，
   merge 后 main 冻结（deny 优先）；仅合入干净分支不冻结；
   一侧撤销一侧冻结的冲突状态仍判冻结。
4. **随机 n<=12 分支对照参考重放**：`acceptance 4` / `4b` —— 种子 1..400 随机日志
   （1–12 分支、6–35 事件、随机 fork/merge/trigger/revoke/join、随机 asOf/分支/账户查询）
   与测试内独立编写的递归参考实现逐点比对 `frozen` 与 `rule`，并校验解释集合事件均不晚于 as-of；
   4b 将全部事件压到同一 ts 验证 seq 序。

## CLI 冒烟

```
$ node cli.js examples/hist.jsonl --as-of 10:3   # 退出码 0
{ "asOf": "10:3", "branch": "main", "account": "default",
  "frozen": false, "rule": null, "explanation": [ rule, join, trigger, merge, revoke ] }

$ node cli.js examples/hist.jsonl --as-of 5:2    # 退出码 0，merge 后 revoke 前
frozen=true, rule=R-MARGIN

$ node cli.js examples/hist.jsonl --as-of 4:0 --branch desk-a   # 退出码 0
frozen=true, rule=R-MARGIN

$ node cli.js examples/hist.jsonl --as-of bad    # 退出码 1
E_TIME: invalid as-of point "bad", expected "ts:seq"
```

备注：本沙箱禁止 `child_process` 派生 node 子进程（EPERM），故 CLI 测试通过
`cli.js` 导出的 `run(args)` 在进程内断言退出码与输出；真实 `node cli.js ...`
进程调用已手工冒烟（见上），行为一致。
