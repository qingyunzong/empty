# moldplan

离线注塑车间排产工具：Node.js 22、仅标准库、`node:test`。导入 JSONL 的
订单/模具/机台/换模矩阵，产出可执行、可审计的排产序列。

## 输入格式（JSONL，每行一条记录）

```json
{"type":"machine","id":"M1"}
{"type":"mold","id":"F1","cycle":2}
{"type":"setup","from":"F1","to":"F2","time":4}
{"type":"order","id":"O1","mold":"F1","qty":4,"due":120,"person":"P1","committed":true}
```

- `cycle`：模具每件加工分钟数；订单加工时长 `proc = qty * cycle`。
- `setup`：换模矩阵（机台从 mold `from` 换到 `to` 的分钟数）。**未知条目默认 0，
  绝不会被当作不可行**。
- `committed: true`：已承诺交期的订单，受撤销保护。

## 命令

```bash
moldplan plan --input base.jsonl --state DIR [--node ID]   # 初始化并排产
moldplan plan --state DIR --insert '{"id":"O9",...}' [--node ID] [--clock JSON]
moldplan plan --state DIR                                  # 重放当前计划（含崩溃恢复）
moldplan undo --state DIR --to SEQ                         # 撤销/恢复到任一操作点
moldplan verify --state DIR                                # 校验证书链 + 重放一致性
npm test                                                   # 等价 node --test
```

## 语义

- **目标与平局**：满足全部交期前提下，按 (最早完工, 换模次数少, 序列字典序)
  字典序取最优，结果完全确定。精确分支限界求解（单机带支配记忆化，等价子集
  DP）；超出节点预算时退化为确定性贪心并在输出中标记 `fallback`。
- **资源互斥**：机台/模具/人员三类资源同一时刻仅服务一个操作，冲突在仿真
  层串行化，绝不静默覆盖。
- **因果时钟**：每个计划操作携带向量时钟。两张**并发**（时钟不可比较）且
  争用同一模具的插入构成冲突：只保留因果先者（因果序的确定性扩展：
  lamport 和 → 节点 → 操作 id），败者标记 `superseded` 并签发冲突证书；
  因果有序的插入双方保留。
- **撤销/恢复**：操作日志仅追加；`undo --to SEQ` 把有效点移到任一历史操作
  （向前移即恢复）。若撤销会改变任一已承诺订单的完工时间或将其移除，拒绝
  并退出 4；否则签发哈希链证书，证明已承诺交期未变。
- **崩溃安全**：`plan.json` 经 `plan.tmp` + fsync + 原子 rename 提交；重启时
  丢弃残留 `plan.tmp`、截断撕裂的日志尾行、按计划日志重放再生派生状态，
  绝不半提交。
- **证书**：`certs.jsonl` 为 sha256 哈希链；`verify` 重放操作日志、重算计划
  并逐条核验证书声明。

## 退出码

| code | 含义 | stderr |
|---|---|---|
| 0 | 成功 | — |
| 2 | 输入非法（解析/schema/未知引用/重复 id） | `{"code","at"}` |
| 3 | 不可行 | `{"code":"INFEASIBLE","conflicts":[...]}` 最小冲突集 |
| 4 | 撤销会破坏已承诺交期 | `{"code":"UNDO_BREAKS_COMMIT","at"}` |
| 1 | 其他/校验失败 | `{"code","at"}` |

## 状态目录

`oplog.jsonl`（操作日志，事实源）、`certs.jsonl`（证书哈希链）、
`plan.json`（派生缓存，原子提交）、`plan.tmp`（崩溃残留，启动即清理）。
