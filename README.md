# rs-chunk-index

遥感大文件分块存储 + 稀疏可信索引（Node.js 22，仅标准库，单机离线）。

## 格式

**数据文件**：16 字节头（magic / u32 blockSize / u32 interval N），随后为块序列。
每块 = 16 字节块头（u64 载荷偏移 | u32 长度 | u32 CRC32C(载荷)）+ 载荷。

**索引文件**：头（magic / version / N / blockSize / blockCount / dataSize / 检查点数 / 位图字节数），
随后每 N 块一个检查点：u64 块号 | u64 文件偏移 | u32 前缀 hash（此前全部块的 CRC32C 链）|
64 字节采样布隆位图（块号双哈希 3 探针）| u32 条目 CRC；末尾 u32 全索引 CRC。

## 行为

- `read(offset, len)` 只用检查点定位：布隆阴性直接 `ERR_BLOOM` miss；阳性仍读块做 CRC32C 确认（失败 `ERR_CRC`）。只读所需块，不整文件加载。
- 越界（含负值、offset+len > dataSize）返回 `ERR_RANGE`，绝不返回空。
- `verifyIndex` 从数据流式重建索引并逐字节比对：索引被改（位图/前缀 hash/任何字节）即 `ERR_INDEX`；数据载荷损坏即 `ERR_CRC`。
- `repair` 只从数据重建索引，绝不修改数据文件；重建是确定性的，索引字节可复现。
- 数据被截断（如末块丢失）：保留区可读，触及缺失块确定地 `ERR_INDEX`，repair 后该区间变为 `ERR_RANGE`。

## API

```js
const { build, open, verifyIndex, repair } = require('./index');
build('src.bin', 'data.bin', 'data.idx', { blockSize: 65536, interval: 16 });
const h = open('data.bin', 'data.idx');
const buf = h.read(100, 37);
h.verifyIndex(); h.repair(); h.close();
// 独立版（索引损坏时仍可用）: verifyIndex(data, idx), repair(data, idx)
```

## CLI

```sh
node cli.js build  <src> <data> <idx> [blockSize=65536] [interval=16]
node cli.js read   <data> <idx> <offset> <len>   # 载荷写 stdout
node cli.js verify <data> <idx>
node cli.js repair <data> <idx>
```

错误一律输出到 stderr 的 JSON：`{"error":"ERR_INDEX|ERR_CRC|ERR_RANGE|ERR_BLOOM","message":...}`，退出码 1。

## 测试

```sh
node --test
```
