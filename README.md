# SQL Server CDC update-mask 合并

面向 SQL Server 变更采集服务的 TypeScript 库。它负责：

- 按 capture instance schema 解释 `__$update_mask`，把位图还原成变更列名；
- 将相同 `capture instance + __$start_lsn + __$seqval` 的 update before(3) / after(4) 行配对；
- 缺半边时保留在 `pending`，cleanup 水位越过后输出永久缺口（gap）；
- 持久化已发布 key 和 pending 半边，服务重启后重放不会重复发布。

库无运行时依赖，源码可直接被 TypeScript 导入，也可以编译后使用。

## 快速使用

```ts
import { CdcChangeMerger } from "dlks-de-0240";

const schema = {
  captureInstance: "dbo_Items",
  columns: [
    { ordinal: 1, name: "id", type: "int" },
    { ordinal: 2, name: "name", type: "nvarchar" },
    { ordinal: 3, name: "qty", type: "int" },
    { ordinal: 4, name: "note", type: "nvarchar" },
  ],
};

const merger = new CdcChangeMerger({ schema });

// __$update_mask = 0x0a => bit 1 和 bit 3 => name、note
merger.ingest({
  __$start_lsn: "0x0000000000000000000a",
  __$seqval: "0x00000000000000000001",
  __$operation: 3,
  __$update_mask: 0,
  id: 7, name: "old", qty: 2, note: "keep",
});

const result = merger.ingest({
  __$start_lsn: "0x0000000000000000000a",
  __$seqval: "0x00000000000000000001",
  __$operation: 4,
  __$update_mask: "0x0a",
  id: 7, name: "new", qty: 2, note: "changed",
});

result.updates[0].changedColumns; // ["name", "note"]
result.updates[0].mergedValues;   // { id: 7, name: "new", qty: 2, note: "changed" }
```

只做掩码解释时可以直接调用：

```ts
import { decodeUpdateMask, explainUpdateMask } from "dlks-de-0240";

decodeUpdateMask("0x0a", ["id", "name", "qty", "note"]);
// ["name", "note"]

explainUpdateMask("0x0a", schema);
// { columns, ordinals, bits, maskHex, columnsByOrdinal, ... }
```

`ordinal` 使用 SQL Server `cdc.captured_columns.column_ordinal` 的 1-based 语义。
掩码 bit 0（首字节最低位）对应 ordinal 1，与 `sys.fn_cdc_is_bit_set` 一致；
超出 schema 的位会被忽略。schema 也接受 `column_name` / `column_ordinal`、
纯字符串列名数组等常见形态。

LSN / seqval 支持 `Buffer`、`Uint8Array`、`0x...` 十六进制、SQL 的
`0000002a:00000018:0004` 形式，以及 number / bigint；比较时忽略前导零字节。

## 待决与永久缺口

```ts
const partial = merger.ingest(afterRow); // 只有 after
partial.pending.length;                  // 1
partial.pending[0].missing;              // ["before"]

// CDC cleanup 已越过该 LSN，缺失半边不可能再出现
const gaps = merger.advanceWatermark("0x0000000000000000000b");
gaps[0].reason;    // "cleanup-watermark"
gaps[0].missing;   // ["before"]

// 迟到的旧行不会重新变成 pending/update
merger.ingest(beforeRow).duplicates[0].reason; // "gap"
```

水位默认按 SQL Server cleanup 语义处理：`pending.lsn < watermark` 才算过期；
需要把等于水位的行也视为过期时，使用 `new CdcChangeMerger({ watermarkInclusive: true })`。
也可以按 capture instance 分别推进：`advanceWatermark(lsn, "dbo_Items")`。

## 重启恢复

```ts
const snapshot = merger.snapshot(); // JSON-safe，含 schemas / published / pending / gaps / watermark
await store.save(JSON.stringify(snapshot));

const restored = new CdcChangeMerger({ schema, state: snapshot });
// 或者：new CdcChangeMerger({ schema }).load(savedJson)

restored.ingestMany(replayedRows);
// 已配对并发布过的 key 会进入 duplicates，不会再次出现在 changes/updates
```

`snapshot()` 会把 pending 行里的 `Buffer` / `Uint8Array` 编码成 JSON 安全格式，
恢复时自动还原。已发布集合默认不会自动裁剪；如需控制内存，可在确认 CDC
不会再回放旧 LSN 后调用 `pruneBefore(watermark)`。

## 主要 API

- `decodeUpdateMask(mask, schema)` / `explainUpdateMask(...)`：解释位图。
- `CdcChangeMerger#ingest(row)` / `ingestMany(rows)`：流式或批量接入 CDC 行。
- `CdcChangeMerger#advanceWatermark(lsn[, instance])`：推进 cleanup 水位并返回新的 gap。
- `CdcChangeMerger#listPending()` / `listGaps()` / `listPublished()`：诊断状态。
- `CdcChangeMerger#snapshot()` / `saveState()` / `restore(state)` / `load(json)`：重启恢复。
- `mergeCdcRows(rows, schema, options)`：有限批次的一次性封装。

`ingest` 返回：

```ts
{
  changes,    // 本次新发布 update / insert / delete
  updates, inserts, deletes,
  gaps,       // 本次新报告的永久缺口
  duplicates, // 因已发布、已报缺口、pending 重复或冲突而跳过的行
  pending,    // 当前全部待决半边
  didPublish,
}
```

插入(2)/删除(1)默认作为单行变更透传；传入
`includeSingleRowChanges: false` 可关闭发布，但仍会记录已处理 key 以避免重放。

## 测试

```bash
npm test
```

测试覆盖掩码位序、稀疏 ordinal、before/after 乱序配对、pending、cleanup gap、
多 capture instance、状态恢复与重启去重。
