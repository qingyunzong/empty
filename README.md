# labflow

单机离线的实验室样品前处理（称重 / 稀释 / 混匀 / 孵育）执行引擎，带崩溃恢复。
Node.js 22，仅标准库，测试使用 `node:test`。

## CLI

```sh
node cli.js run     --protocol protocol.json --journal run.jsonl [--state dir] [--result f]
                    [--crash-at step:point] [--abort-at step] [--now ms] [--run-id id]
node cli.js recover --journal run.jsonl [--state dir] [--result f] [--report f]
                    [--abort-at step] [--now ms]
```

- `run` 开启新运行（journal 必须为空），`recover` 从既有 journal 恢复并继续。
- state 目录默认 `<journal 所在目录>/state`；`result.json` / `recovery_report.json` 默认写到 journal 同目录。
- `--now ms` 注入逻辑时钟（恢复时据此判定 timeout），缺省用 `Date.now()`。

退出码：`0` 完成；`1` 已中止（补偿链已落盘）；`2` 一致性/用法错误；`70` 模拟断电。

## 协议

```json
{
  "name": "sample-prep",
  "inputs": ["sample"],
  "steps": [
    { "id": "weigh", "op": "weigh", "requires": ["sample"], "produces": ["weighed"] },
    { "id": "incubate", "op": "incubate", "requires": ["..."], "produces": ["..."], "timeout": 60000 }
  ]
}
```

依赖由 `requires`/`produces` 推导；无依赖关系的步骤构成并行分支（同一 layer 并发执行），
入度 ≥ 2 的步骤为汇合点，必须等全部上游 effect 可见才会执行。

## 日志与恢复

journal（JSONL，只追加）按三段落盘：`intent` → `effect` → `checkpoint`。
故障注入点固定为 `before-effect`、`after-effect`、`during-checkpoint`
（checkpoint 写盘中会产生撕裂行，恢复时截断）。恢复语义：

- 已有 checkpoint：跳过，effect 绝不重复；
- 有 effect 无 checkpoint：只补 checkpoint；
- 只有 intent（半成品）：`now - intent.ts > timeout` 则作废并触发补偿，否则继续执行；
- state 目录中无 effect 支撑的孤儿产物文件被清除；effect 已提交但产物文件缺失 → `MISSING_PRODUCT`。

abort（`--abort-at` 或超时作废）生成 saga 式补偿链（逆拓扑序写入 journal，可审计）：
已完成步骤的已消耗样品只能 `mark_consumed`，未开始步骤 `release` 释放占用，
无人消费的中间产物 `discard`。

## 错误（exit=2）

- `MISSING_PRODUCT` 缺产物：effect 已提交但 state 中产物缺失，或步骤提交时上游产物不可见；
- `TIMEOUT_JOIN` 超时仍汇合：上游步骤因超时被作废，但下游汇合步骤已有提交的 effect；
- `ABORT_COMPLETED_JOIN` abort 已完成汇合：对已 checkpoint 的汇合步骤请求 abort。

## 测试

```sh
node --test
```

- `test/acceptance.test.js` 验收 1–4：三故障点恢复与连续运行参考一致；并行分支其一 abort 汇合不触发；
  超时孵育恢复后作废且补偿可审计；5 步协议 × 3 故障点共 15 个崩溃位置逐一恢复并对照状态。
- `test/errors.test.js` 三类 exit=2 错误、撕裂行截断、CLI 用法错误。
