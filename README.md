# 分页表格跨页选中保持

面向 RPA 的 TypeScript 表格选择状态组件。选择集合以业务键为唯一身份，
不依赖行下标、DOM 节点或当前页数据；服务端分页、排序、筛选和行虚拟化都
不会丢失目标集合。

## 两组 API

- `TableSelectionStore`：纯状态层。维护目标集合、当前已观察到的行、谓词
  过滤和序列化状态，可直接接入 React 的 `useSyncExternalStore`。
- `TableSelectionController`：RPA 编排层。围绕 `snapshot -> predicate ->
  click -> snapshot` 执行动作，并负责重试与幂等。

```ts
import {
  ActionJournal,
  TableSelectionController,
  TableSelectionStore,
} from "./index.ts";
```

## 适配器契约

```ts
const adapter = {
  // 只返回当前已渲染/已加载的行；虚拟化窗口之外的行可以没有。
  async snapshot() {
    return {
      rows: [
        { id: "A-100", status: "active", selected: false },
        { id: "A-101", status: "active", selected: true },
      ],
      // 也可以使用 checkedKeys 表示勾选状态。
      // checkedKeys: ["A-101"],
      page: 2,
      revision: "list-v42",
    };
  },

  // 幂等：把状态设置为 checked，而不是“点一下切换”。
  async setRowChecked(key: string, checked: boolean) {
    // locator(`[data-row-key="${key}"] input[type=checkbox]`)
    //   根据 checked 决定是否点击。
  },

  // 可选：虚拟化行不在 DOM 中时滚动到该行。
  async scrollToRow(key: string) {},

  // 可选：服务端分页时切换到包含该 key 的页，并返回新快照。
  async locateRow(key: string) {},

  // 可选：等待表格重新渲染稳定。
  async waitForStable() {},

  // 可选：供 runMatching 遍历所有服务端页。
  async *pages() {
    // yield { rows: page1 };
    // yield { rows: page2 };
  },
};
```

`snapshot()` 中的每行必须有非空、唯一的业务键。键可以是字符串或有限数字；
内部统一按字符串比较，因此 DOM 文本 `"7"` 与接口返回的 `7` 指向同一行。

## 跨页选择

```ts
const store = new TableSelectionStore<Row>({
  keyField: "id",
  predicate: (row) => row.status === "active",
});

// 第 1 页
store.observe(await adapter.snapshot());
store.selectMany(["A-100", "A-101"]);

// 翻页、排序或筛选后，旧页的行即使已卸载，选择仍然保留。
store.observe(nextPageSnapshot);
console.log(store.getSelectedKeys()); // ["A-100", "A-101"]

// 只清理本次快照中能证明已不符合谓词的行；其他页的目标保留。
store.reconcile(refreshedPage, (row) => row.status === "active");
```

常用方法：`observe/setRows/update`、`select/deselect/toggle`、
`selectMany/deselectMany`、`has/isSelected`、`getSelectedKeys`、
`getSelectedRows`、`replace`、`clear`、`prune`、`reconcile`。

## RPA 执行

```ts
const journal = new ActionJournal();
const controller = new TableSelectionController<Row>({
  adapter,
  store,
  keyField: "id",
  predicate: (row) => row.status === "active",
  maxAttempts: 3,
  retryDelayMs: 200,
});

// 逐个执行。每次动作前都会重新抓取快照并重新计算谓词。
const result = await controller.run(["A-100", "A-101"]);

// 或先跨所有服务端页收集满足谓词的键，再逐个执行。
await controller.runMatching((row) => row.status === "active");
```

单行结果状态：

- `selected` / `deselected`：已点击，并由动作后快照确认。
- `already-selected` / `already-deselected`：动作前快照已是目标状态，不点击。
- `skipped-predicate`：刷新后的行不再符合谓词，不点击。
- `skipped-journal`：`(action, key)` 已成功过，重试不重复触发。
- `failed`：重试耗尽；调用 `run` 时默认抛出最后一次错误。

### 安全保证

1. **业务键身份**：目标集合使用 `keyField`（或 `key`/`keySelector` 函数），
   与页码、排序位置、筛选结果和虚拟化下标无关。
2. **刷新后重新判定**：每次勾选前都重新 `snapshot()`，并用最新行数据调用
   谓词。旧目标不再符合谓词时返回 `skipped-predicate`，绝不点击。
3. **重复/缺失键即停止**：快照中出现重复业务键、行缺少业务键、目标键重复
   或目标键为空都会抛错。批量目标会在第一次点击前完成预检。
4. **前后快照确认**：动作前确认键唯一、行仍符合谓词、当前勾选状态与目标
   不同；动作后确认同一业务键已处于目标状态。确认失败进入重试。
5. **幂等重试**：`setRowChecked` 写入的是目标状态；重试前重新抓取快照，
   若已处于目标状态则不点击。成功动作写入 `ActionJournal`，后续重试直接
   跳过。
6. **失败即停**：重复键、缺失键、禁用行、谓词异常属于终止错误；当前批量
   动作立即停止，不继续操作后续行。

## 刷新后的持久化

页面刷新会丢掉 DOM 和内存状态。持久化选择集合与动作日志后恢复：

```ts
const saved = JSON.stringify({
  selection: store.toJSON(),
  journal: journal.toJSON(),
});

const selection = TableSelectionStore.fromJSON<Row>(saved.selection, {
  keyField: "id",
  predicate: (row) => row.status === "active",
});
const restoredJournal = ActionJournal.fromJSON(saved.journal);

const controller = new TableSelectionController({
  adapter,
  store: selection,
  journal: restoredJournal,
  predicate: (row) => row.status === "active",
});

// 只处理仍然满足谓词且未成功过的行。
await controller.run(selection.getSelectedKeys());
```

`ActionJournal` 还支持 `ActionJournal.load(storage)` 和 `flush()`，
其中 `storage` 需实现 `load()` / `save(records)`。

## 错误码

所有选择错误继承 `TableSelectionError`，可通过 `error.code` 判断：

| code | 含义 |
| --- | --- |
| `MISSING_BUSINESS_KEY` | 行或目标缺少有效业务键 |
| `DUPLICATE_BUSINESS_KEY` | 同一快照/目标集合中出现重复业务键 |
| `ROW_NOT_FOUND` | 当前快照找不到目标键 |
| `DISABLED_ROW` | 行被禁用，无法切换到目标状态 |
| `SNAPSHOT_CONFIRMATION_FAILED` | 动作后快照未确认目标状态 |
| `ADAPTER_ERROR` | 快照、滚动、定位或点击适配器失败 |
| `PREDICATE_ERROR` | 谓词求值抛错 |

## 测试

```bash
npm test
npm run typecheck
```
