# auditdb — 双时态稽核回溯库与 CLI

Node.js 22，仅标准库。事件只追加，更正生成新版本，删除生成 tombstone，
支持 `asOf(validTime, txSeq)` 查询账户余额与限额占用。

## 事件格式（JSONL 每行一条）

```json
{"id":"e1","account":"acc","validFrom":"2024-01-01T00:00:00Z","validTo":null,
 "txSeq":1,"payload":{"amount":100,"limit":40},"supersedes":null,"tombstone":false}
```

- `validTo: null` 表示当前有效（开区间），可被后续更正关闭；`validFrom` 含、`validTo` 不含。
- `txSeq` 全局严格递增（事务时间），`supersedes` 指向被更正版本（同账户）。
- `tombstone: true` 必须带 `supersedes`；tombstone 不可再被更正（删除是终态）。
- 聚合：`sum` 忽略 NULL `amount`/`limit`，`count` 计可见版本数。

## 可见性语义（关系代数）

```
known  = σ account, txSeq≤N (events)            -- 选择：事务时间
heads  = known ⋉̸ {同链更新版本 tx≤N}             -- 反连接：链首
result = σ ¬tombstone ∧ validFrom≤T<validTo (heads)  -- 选择：有效时间
```

实现于 `src/algebra.js`（暴力参考）与 `src/index.js`（每账户版本链增量索引，
链内二分查找，asOf 不全表扫）；`test/convergence.test.js` 用 2000 版本对照两者。

## CLI

```
auditdb load <file.jsonl> [--db path]                 # 校验后追加到存储
auditdb query <acc> --valid <ISO时间> [--tx N] [--db path]
```

错误：`E_TIME_ORDER`（validTo≤validFrom、txSeq 非递增）、`E_TOMBSTONE`
（更正 tombstone、无 supersedes 的 tombstone），均 exit 1，stderr 输出 JSON。

## 测试

```
node --test
```

结果见 `RESULTS.md`。
