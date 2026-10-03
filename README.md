# qc-records

离线检验记录库及 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 布局

```
<root>/<batchId>/manifest.json     # 清单：基线、公差、块列表、nextSeq（提交点）
<root>/<batchId>/chunks/000001.chk # 数据块：JSON 头行 + JSONL 负载，负载带 CRC32
```

- 每批次首条记录为基线值（seq 0），后续测量只存相对前一条原始值的 delta。
- 块头：`{"magic":"QCHK1","index,"records","bytes","crc32"}`，CRC32（IEEE）覆盖负载字节。
- 写入：数据先写 `<chunk>.tmp` 再 rename 就位，然后写 `manifest.json.tmp` 并 rename。
  清单 rename 是原子提交点；此前崩溃的补偿记录留在磁盘上但不被清单引用，读取不可见。
  解码与合并均以清单中的记录数为准，忽略崩溃残留的多余尾部。

## 记录类型

- `baseline`：批次基线值与公差 `[min, max]`。
- `measure`：测量，存 `delta`；迟到测量按追加顺序入日志，时间索引仍按测量时间定位。
- `compensate`：补偿记录，含 `refs`（被替代测量序号）、`reason`；绝不覆盖旧值，只追加。

## 解码

`decode(batchId, { asOfSeq })` 增量解码输出：

- `history`：原始历史（每条含原始值、当时判定、是否被替代）；
- `effective`：当前生效值与合格判定（超差只是判定结论，不是文件错误）；
- `correctionReason`：当前生效值来自补偿时的修正原因；
- `asOfSeq` 可重放历史任意点，复现旧判定用于审计。

## 错误码

- `E_CRC`：块损坏（头/长度/CRC 校验失败）。损坏块之前的状态可恢复，之后的块不被应用；
  重启扫描结果一致。CLI 退出码 3。
- `E_REFERENCE`：补偿记录引用不存在的测量序号（追加时与解码时均校验）。CLI 退出码 4。

## CLI

```
qc [--root DIR] init <batch> --baseline N --min N --max N [--chunk-size N] [--at T]
qc [--root DIR] measure <batch> --value N [--at T]
qc [--root DIR] correct <batch> --refs SEQ --value N --reason TEXT [--at T]
qc [--root DIR] show <batch> [--as-of SEQ]
qc [--root DIR] find <batch> --at T
qc [--root DIR] list | scan
```

退出码：0 成功，1 一般错误，2 用法错误，3 `E_CRC`，4 `E_REFERENCE`。

## 测试

```
node --test
```
