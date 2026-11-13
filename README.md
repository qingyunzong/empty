# 动态任务映射收敛

工作流服务要可直接接入 TypeScript 动态映射状态组件，上游清单版本决定子任务集合。重试收到相同清单幂等，清单修订可新增或取消尚未开始子任务，但已成功结果保留版本归属；聚合节点只在当前清单所有终态后触发一次。

## 组件

`DynamicMapState`（见 `src/dynamic-map-state.ts`）是可直接嵌入工作流服务的动态映射状态组件：

- `applyManifest(manifest)`：应用上游清单（`{ version, items }`）。
  - 相同版本且条目一致的重试为幂等空操作，返回 `null` 并发出 `manifest-ignored` 事件。
  - 相同版本但条目不一致抛出 `ManifestConflictError`；条目重复抛出 `InvalidManifestError`。
  - 新版本清单触发修订：新条目置为 `pending`；不在新清单中且尚未开始的子任务取消（`cancelled`）；已在运行的子任务标记为 detached 继续执行；已终态的子任务不受影响。
- `startSubtask(key)` / `completeSubtask(key, value)` / `failSubtask(key, error)`：驱动子任务状态机 `pending → running → succeeded|failed`，非法迁移抛出 `InvalidTransitionError`。
- 成功结果以 `SubtaskResult.version` 记录其完成时所属的清单版本，跨修订保留，可通过 `getResult(key)` 读取。
- 当前清单内全部子任务到达终态（`succeeded` / `failed` / `cancelled`）后，恰好发出一次 `aggregate` 事件，快照仅含当前清单条目的结果与失败；清单修订会开启新的聚合周期。detached 子任务的迟到结果仍按版本归属保留，但不参与也不阻塞聚合。
- `subscribe(listener)` 订阅全部状态事件，返回取消订阅函数。

## 测试

```sh
npm test
```
