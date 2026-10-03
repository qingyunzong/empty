# qrec — 离线检验记录库

Node.js 22、仅标准库。测量记录按批次（batch）组织，追加式存储，支持迟到测量与更正补偿，带 CRC32 校验的分块格式和原子提交。

## 存储格式

```
<dir>/
  manifest.json          # 批次元数据 + 已提交块清单（tmp 写入 + rename 原子替换）
  chunks/chunk-000000.bin
  chunks/chunk-000001.bin
  ...
```

- 每批次在 manifest 中登记基线值（baseline）与公差（tolerance）。
- 块格式（大端）：`magic | chunkSeq | batchId | baseTime u64 | baseValueScaled i64 | recordCount | records... | CRC32`。
- 数值按 1e6 缩放为整数；时间存为相对 baseTime 的 zigzag 增量，测量值存为相对前一条记录的 zigzag delta（链起点为块头 baseValueScaled），因此每个块自包含，迟到（时间戳更小）的记录也合法。
- 记录类型：`BASELINE` / `MEASURE(seq)` / `COMPENSATE(targetSeq, reason)`。

## 提交与崩溃语义

写入先落块数据文件（`tmp` + fsync + rename），再更新 manifest（`tmp` + fsync + rename）。rename 前崩溃只会留下孤儿块文件和 manifest 临时文件，重启扫描只读 manifest 清单，崩溃中的补偿不可见。

## 解码语义

增量解码按追加顺序重放：

- `history`：原始历史（含被替代的测量，标记 `superseded`）；
- `effective`：每个测量序号的当前生效值；
- `judgment`：合格判定，`|value - baseline| <= tolerance`（边界含等号）；超差只影响判定，不是文件错误；
- `corrections`：补偿记录及修正原因、旧值/新值。

`decode(batch, { upToRecords: K })` 只重放前 K 条记录，可重现任一历史时点的判定。

## 错误码

- `E_CRC`：块 CRC 校验失败；扫描在坏块边界停止，边界前状态保留，边界后（含后续好块）不应用，重启扫描结果一致。
- `E_REFERENCE`：补偿记录引用了不存在的测量序号。
- `E_FORMAT` / `E_VALUE` / `E_BATCH` / `E_NOTFOUND` / `E_USAGE`。

## CLI

```
qrec create  <dir> <batch> --baseline N --tolerance N [--time MS]
qrec add     <dir> <batch> --value N [--time MS]
qrec correct <dir> <batch> --seq N --value N --reason S [--time MS]
qrec show    <dir> <batch> [--records K] [--json]
qrec audit   <dir> <batch> --records K
qrec locate  <dir> <batch> --time MS
qrec verify  <dir>
```

退出码：0 正常；2 用法错误；3 `E_CRC`；4 `E_REFERENCE`；5 未找到；6 批次冲突；7 数值非法。

## 测试

```
node --test
```
