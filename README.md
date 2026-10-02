# maint-sync

离线优先的维修工单同步库与 CLI。维修平板与设备服务器离线各自开完工单，
报警事件联动工单状态，回连后双向合并，恰好一次生效，全程可审计。
仅依赖 Node.js 22 标准库，测试使用 `node:test`，单机离线可运行。

## 模型

- **事件源**：一切变更（`create/assign/start/complete/cancel/raise/clear`）先落
  `events.log`（JSONL，哈希链 `hash = sha256(prevHash + canonical(event))`），
  状态是事件集合的纯函数投影，重复回放不产生重复效果。
- **向量时钟**：每个事件携带站点向量时钟；因果前因缺失的事件进入 `pending`，
  前因补齐后投影自动重算生效，无需重投。
- **变更捕获**：`emit` 本地产生事件并同步更新日志/索引/快照/清单。
- **检查点恢复**：`state.json` 为快照检查点（tmp+rename 原子替换），
  `index.json` 为事件 id 去重索引，`audit-manifest.json` 锚定链头与快照哈希。
  `resume` 以日志为准：验链 → 重建半索引 → 重算投影 → 重写快照与清单。

## 状态机

```
create -> created
created  --assign--> assigned    created  --cancel--> cancelled
assigned --start-->  started     assigned --cancel--> cancelled
started  --complete--> completed
```

- 显式禁止：`completed -> start`、`cancelled -> assign`（及一切表外迁移），
  本地 `emit` 拒绝并退出码 3；远端非法事件在投影中标记 `rejected`。
- 报警联动：工单存在活动报警时 `complete` 被拒绝（`alarm-active`）；
  `clear` 仅当其向量时钟因果晚于对应 `raise` 才有效，否则拒绝
  （`clear-before-raise`）；`raise` 未知时 `clear` 进 `pending`。

## 双向合并与冲突

`sync --store A --peer B` 双向补齐缺失事件（按 id 去重），双方各自重算
确定性投影（因果拓扑序，同 ready 集合按 `(site, seq)` 决胜），保证收敛：

- **同人并发 assign 不同班组**：确定性规则 `(team, site, seq)` 字典序小者胜，
  败者标记 `superseded`，冲突记入 `conflicts`（`rule: team-lexicographic`）。
- **安全联锁冲突**：`create` 携带 `{"safety": true}` 的工单发生上述冲突时，
  双方事件及其因果后继全部 `held`，冲突状态 `pending`，`sync` 退出码 9，
  等待人工处理。

## CLI

```
maint-sync emit  --store DIR --site S --type T --order ID [--data JSON] [--actor WHO]
maint-sync apply --store DIR (--event JSON | --file PATH)
maint-sync sync  --store DIR --peer DIR
maint-sync resume --store DIR
maint-sync audit --store DIR
```

- stdout：JSON 结果；stderr：JSON 错误 `{"error":{"kind","message",...}}`。
- 退出码：`0` 成功；`2` 用法/IO/存储损坏；`3` 领域拒绝（非法迁移、
  clear-before-raise、审计失败）；`9` 未决（pending / 安全联锁冲突挂起）。

## 持久化故障点与恢复

故障注入（仅测试）：`MAINT_SYNC_CRASH=<point>` 在精确位置 `exit(70)` 模拟掉电。

| 故障点 | 位置 | 恢复行为 |
|---|---|---|
| `before-append` | 事件写入日志前 | 无残留，状态不变 |
| `after-append` | 日志已写、索引未建 | `resume` 重建半索引，事件恰好一次生效 |
| `before-rename` | `state.json.tmp` 已写、rename 前 | 旧检查点保留，`resume` 重算并替换 |
| `after-manifest` | 审计清单已提交 | 已提交内容一致，`resume` 为无操作 |

## 测试

```
node --test
```

覆盖：重复投递幂等、非法迁移退出码、四个故障点恢复、报警因果、
双向冲突收敛、审计/篡改检测，以及 `n<=9` 全部 2,441,405 条命令序列
对独立参考状态机（`src/reference.js`）的逐步枚举对照。真实结果见 `RESULTS.md`。
