# qc-loop — 装配厂质量闭环离线管理

Node.js 22、仅标准库、单机离线。管理缺陷(open)、返工(rework)、复检(inspect/correct)、
报废(scrap)闭环，状态持久化为 **JSON 快照 + WAL**，崩溃后可证明恢复。

## 运行

```sh
node src/cli.js <cmd> [--dir <dataDir>]   # 或设置 QC_DATA_DIR
node --test                               # 全量测试
```

命令：`open / rework / inspect / correct / close / scrap / undo / crash-recover / verify / state`

## 存储与崩溃恢复

每次变更的流程（`src/store.js`）：

1. 干跑校验（失败则不落盘）→ 2. 追加 WAL（含每条记录 SHA-256 校验和）→ 3. fsync WAL
→ 4. 写 `snapshot.json.tmp` + fsync → 5. rename 为 `snapshot.json` → 6. 更新 `index.json`

三个固定故障注入点（`QC_CRASH_AT` 注入，进程以 exit 2 模拟崩溃）：

| 故障点 | 位置 | 恢复结果 |
|---|---|---|
| `wal-append` | WAL 追加后、fsync 前 | 重放 WAL 尾部（快照 lastSeq 之后的记录） |
| `snapshot-rename` | 快照 rename 前 | 忽略并清理半快照 `snapshot.json.tmp` |
| `index-update` | 索引更新后 | 从状态全量重建索引，重复恢复不得双计 |

`crash-recover`：忽略半快照 → 载快照 → 校验并重放 WAL → 全量重建索引 →
与从零重放 WAL 的参考状态比对哈希 → 持久化。`verify` 做同样的一致性校验（只读）。

## 领域规则（`src/machine.js`）

- 缺陷可合并进返工单（`rework R1 D1 D2 ...`），每个缺陷对应工单内一个序列。
- 报废是墓碑（`tombstones`）：阻断再开、阻断并入返工单，且不可撤销——报废后返工不得复活。
- 复检更正（`correct`）触发**增量影响集**：仅该工单中序号 ≥ 更正点的序列被标记
  `affected` 并重置待复检；之前的序列与其他工单不受影响。
- 闭环（工单 close / 缺陷 closed / 报废墓碑）后的节点禁止撤销；未闭环节点的撤销
  会写入 `audit` 审计轨迹。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 领域错误（如墓碑阻断、未全通过就 close） |
| 2 | 模拟崩溃（故障注入） |
| 21 | 闭环后撤销 |
| 22 | WAL 校验失败 |
| 23 | 恢复前后状态哈希不一致 |

## 验收对照（测试）

- `test/fault-points.test.js` — 验收 1：三个故障点注入，恢复结果明确（重放 WAL / 忽略半快照 / 重建索引不双计）。
- `test/scrap.test.js` — 验收 2：报废后 rework/再开/撤销均无法复活。
- `test/correct.test.js` — 验收 3：更正复检只扩散到受影响序列。
- `test/enumeration.test.js` — 验收 4：60 组长度 ≤12 的操作序列（含随机故障注入），
  持久化恢复状态与参考状态机（从零折叠操作日志）逐一比对规范哈希。
- `test/errors.test.js` — 退出码 21/22/23 及撤销审计。

注：测试在进程内调用 CLI `main()`（本沙箱禁止 node 派生 node 子进程）；
崩溃注入以异常模拟，与 `process.exit(2)` 在故障点的落盘状态完全一致。

## 真实测试结果（2026-10-08, node v22.22.1）

```
ok 1 - test/correct.test.js
ok 2 - test/enumeration.test.js
ok 3 - test/errors.test.js
ok 4 - test/fault-points.test.js
ok 5 - test/scrap.test.js
# tests 5
# pass 5
# fail 0
```
