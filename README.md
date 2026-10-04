# gate-interpreter

离散装配厂夜班离线排产闸门解释器。Node.js 22，仅标准库，测试用 `node:test`。

计划员向 `release.jsonl` 追加「放行 / 冻结 / 改期 / 撤销」事件，闸门解释器
重放事件日志，决定工单能否进入次日队列，输出 `schedule.out.json` 与
`breach.json`（以及补偿审计 `compensation.jsonl`）。

## 用法

```sh
node bin/gate.js run --config examples/plant.json --events examples/release.jsonl --outdir .
node bin/gate.js replay --config examples/plant.json --events examples/release.jsonl --from 3
node bin/gate.js counterexample --config examples/plant.json --events examples/release.jsonl --order WO-1
node bin/gate.js validate --config examples/plant.json --events examples/release.jsonl
```

## 事件模型（release.jsonl，每行一个 JSON）

- `{"ts","type":"release","order","priority?"}` 放行
- `{"ts","type":"freeze","order","priority?"}` 冻结
- `{"ts","type":"revoke","target":<seq>,"actor":"supervisor"}` 主管撤销冻结
- `{"ts","type":"reschedule","order","to"}` 改期（`to` 不得早于事件时间）

## 核心机制

- **三级权限继承**：工单 → 工作中心 → 产品线，`allow` / `deny` / `inherit`。
- **冲突决议**：按（时间戳， 优先级， 类型， 序号）确定性地取胜者；
  同刻同级**冻结胜**，同类型则后写胜。
- **补偿事件**：已消耗物料锁的放行被冻结覆盖时，不改写历史，而是向
  `compensation.jsonl` 追加补偿事件并归还库存；撤销冻结后锁自动恢复。
- **审计重放**：状态是事件日志的纯函数，`replay --from N` 可从任意事件号
  续放到同一状态（sha256 状态哈希校验）。
- **反例生成**：BFS 搜索使某工单从可放行变为不可放行的最小追加事件序列。

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功 |
| 2 | 用法 / IO / 格式错误 |
| 5 | 时间倒退（事件时间戳回退或改期到过去） |
| 6 | 班组能力为负数 |
| 7 | 未知物料 |

## 测试

```sh
node --test
```
