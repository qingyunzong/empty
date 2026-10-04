# sample-cert-cache

科学样本分块缓存与窗口证书校验库 + CLI。仅使用 Node.js 22 标准库。

## 模型

- 样本文件按固定 `chunkSize` 分块；每块记录 CRC32 与单调递增的代际 `generation`（从 1 开始）。
- 块摘要 `digest = sha256(generation ‖ crc ‖ data)`，证书根 `root = sha256(concat(digests) ‖ count)`。
- 证书 `{ version, sample, window:{start,end}, generation, bitmap, digests, root }`：
  - `generation` 为窗口内最大代际；`bitmap` 标记窗口中处于该代际的块（被证书覆盖）。
  - `checkCert` 要求被覆盖块的当前代际等于证书代际，否则报 `ERR_STALE`。
- `correctRange` 只提高受影响块的代际，其余块不变，因此旧窗口证书自然失效。
- 缓存按字节 LRU 淘汰；代际与 CRC 元数据不参与淘汰，淘汰不影响正确性（未命中回源重读）。
- 缓存块 CRC 校验失败时从源文件重读修复；源也损坏（CRC 不符/不可读）报 `ERR_SOURCE`。
- 相邻证书合并（`mergeCertificates` / `cli.js merge`）：仅当窗口相接（`a.end + 1 === b.start`）
  且代际一致时合并，重叠或代际不同则保持并列。

## 错误码（stderr JSON）

`ERR_STALE` 证书代际过期 · `ERR_CRC` 证书损坏/摘要不符 · `ERR_SOURCE` 源与缓存双坏 · `ERR_RANGE` 范围非法

## 库

```js
const { SampleCache, mergeCertificates } = require('./lib');
const cache = new SampleCache({ capacity: 8 * 1024 * 1024 });
cache.ingest('sample', 'sample.bin', { chunkSize: 4096 });
cache.correctRange('sample', 3, 5);          // 重读源文件对应块并提升代际
const cert = cache.certify('sample', 0, 9);  // 签发窗口证书
cache.checkCert('sample', cert);             // 校验，失败抛 CacheError（含 .code）
cache.invalidate('sample', 0, 9);            // 使缓存块失效（回源重读）
```

## CLI

```
node cli.js ingest <sample> <source> [--chunk N] [--capacity N] [--dir D]
node cli.js correctRange <sample> <start> <end> [--source P] [--dir D]
node cli.js certify <sample> <start> <end> [--out FILE] [--dir D]
node cli.js checkCert <sample> <certFile> [--dir D]
node cli.js invalidate <sample> [start end] [--dir D]
node cli.js merge <certFile...>
```

状态持久化在 `--dir`（默认 `./.sample-cache`）。成功结果输出到 stdout（JSON），
错误以 JSON 输出到 stderr 并以退出码 1 终止。

## 测试

```
node --test
```
