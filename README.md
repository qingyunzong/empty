# maint-sync

离线优先的维修工单同步库与 CLI。仅使用 Node.js 22 标准库与 `node:test`，单机离线运行。

场景：维修平板与设备服务器离线各自开/完工单，报警事件驱动工单状态，回连后双向合并，
保证每个事件**恰好一次生效**且全程可审计。

## 模型

- **事件源（event sourcing）**：一切变更都是事件，追加到 `events.jsonl`；状态是事件的确定性折叠。
- **命令**：工单 `create/assign/start/complete/cancel`，报警 `raise/clear`。
- **向量时钟**：每个事件携带 `vc`（站点 → 逻辑计数）。事件只有在其因果前驱全部就绪后才应用；
  因果未知（前驱缺失）的事件进入 `pending`，后续事件到达后自动重试。
- **变更捕获**：`emit` 本地产生事件（本站点 vc +1），`apply`/`sync` 捕获外部事件，
  按 `site:seq` 去重 —— 重复投递是 no-op。
- **检查点恢复**：`state.json` 快照记录 `logCount + logHash`，仅当完全覆盖当前日志才被信任，
  否则从事件日志全量重建。

## 状态机

```
create → new → assign → assigned → start → in_progress → complete → completed
               └────────── cancel（new/assigned/in_progress）→ cancelled
```

- 禁止 `complete → start`、`cancel → assign`（完整迁移表见 `src/machine.js` 的 `WO_TRANSITIONS`）。
- 非法迁移在 `emit` 时本地拒绝（退出码 3）；合并进来的非法事件记为 `rejected` 并写入审计。
- 报警 `clear` 仅当**因果上晚于** `raise` 才有效；`raise` 未知 → `pending`；并发或早于 → `rejected`。

## 双向合并与冲突

`sync --a A --b B` 双向交换缺失事件后各自确定性重折叠，两端状态必然一致（收敛由测试断言）。

- **同人并发 assign 不同班组**：确定性规则 —— 按 `(site, seq)` 全序，先者胜
  （`first-wins`），败者记 `rejected/conflict-loser`，冲突写入 `state.conflicts` 与审计。
- **安全联锁冲突**（任一冲突事件带 `--interlock`）：不自动裁决，事件进 `pending`，
  冲突记 `resolution: pending`，等待人工处理。

## 持久化与故障点

每个数据目录：

```
events.jsonl        追加写事件日志（fsync）
index.json          已应用索引（tmp+rename）
state.json          状态快照（tmp+rename）
audit.jsonl         哈希链审计日志
manifest.json       审计清单 {count, head}（tmp+rename，最后提交）
```

写入顺序即四个故障点，恢复行为由 `resume` 保证：

| # | 故障点 | 恢复行为 |
|---|--------|----------|
| 1 | event append 前 | 无任何部分状态，日志不变 |
| 2 | append 后、索引建立前 | 从日志重建索引与状态，事件不重复应用，缺口补一条 `recovery` 审计 |
| 3 | state snapshot rename 前 | 丢弃孤儿 `*.tmp`，旧快照/日志为准；快照丢失则从日志重建 |
| 4 | audit manifest commit 后 | 已一致；manifest 之后的撕裂尾部被截断，链校验通过 |

`resume` 幂等：连续运行结果相同，事件绝不重复应用。

## CLI

```bash
maint-sync emit   --dir D --site S --actor U <create|assign|start|complete|cancel|raise|clear>
                  [--wo W] [--team T] [--alarm A] [--interlock]
maint-sync apply  --dir D --file events.jsonl   # 合并外部事件流（去重）
maint-sync sync   --a D1 --b D2                 # 双向合并，输出 converged
maint-sync resume --dir D                       # 崩溃恢复，输出修复报告
maint-sync audit  --dir D [--verify]            # 输出/校验哈希链审计
```

- stdout：JSON 结果；stderr：JSON 错误 `{"error":{"code","message",...}}`。
- 退出码：`2` 用法/输入错误，`3` 领域拒绝（非法迁移等），`9` 内部/完整性错误。

## 验收测试（真实结果）

运行 `node --test`（Node v22.22.1，2026-10-03）：

```
ok 1 - test/cli.test.js
ok 2 - test/faults.test.js
ok 3 - test/machine.test.js
ok 4 - test/sync.test.js
# tests 4
# pass 4
# fail 0
```

22 个子测试全部通过，覆盖全部验收项：

- **重复投递**：`apply` 同一事件流两次（第二次全部判重、状态不变）；日志内重复事件折叠去重。
- **非法迁移**：`complete→start`、`cancel→assign` 等在折叠层 `rejected`，CLI 退出码 3。
- **四故障点**：见上表，`test/faults.test.js` 逐项模拟崩溃并验证恢复（含恢复幂等）。
- **n≤9 枚举对照**：`test/machine.test.js` 用独立编写的参考状态机，
  对 7 个命令在深度 ≤9 内做 BFS 全枚举（所有可达状态 × 所有命令），
  逐步与库实现比对终态一致。
- **冲突与报警**：并发 assign 确定性裁决且两端收敛、联锁冲突 pending、
  clear 因果校验（未知 → pending、并发 → rejected、晚于 raise → 生效）、
  因果缺口事件 pending 并在补齐后自动应用。
- **审计**：哈希链 + manifest 校验；篡改已提交条目 → `audit --verify` 退出码 9。

注：沙箱禁止子进程，测试通过拦截 `process.stdout/stderr/exit` 在进程内驱动 CLI
（`test-support/helpers.js`），CLI 本身可作为独立进程正常运行。
