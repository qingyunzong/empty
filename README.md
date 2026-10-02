# sample-cache

可信样本窗口缓存：科学样本分块编码（块含 CRC32 与代际 generation），
缓存证书记录窗口、Merkle 根、逐块代际与覆盖位图。Node.js 22，仅标准库。

## 库

```js
const { SampleCache } = require('./lib/cache');
const cache = SampleCache.ingest('sample.bin', { blockSize: 1024, capacity: 1 << 20 });
const cert = cache.certify(0, 4096);        // { window, root, generations, bitmap, ... }
cache.correctRange(10, 20, Buffer.alloc(10)); // 仅提高受影响块的代际
cache.checkCert(cert);                      // -> CacheError ERR_STALE
cache.invalidate(0, 2048);                  // 淘汰缓存块并撤销相交证书
```

- 缓存容量按字节 LRU 淘汰；淘汰不影响正确性（miss 时回源重读）。
- 缓存块 CRC 损坏时回源修复；源也损坏报 `ERR_SOURCE`。
- 相邻证书仅当窗口相接且代际一致时合并，否则在证书库中并列保存。

## CLI

```
node cli.js ingest <sample> [--block-size N] [--capacity BYTES]
node cli.js correctRange <sample> <start> <end> (--fill N | --data FILE | --text STR)
node cli.js certify <sample> <start> <end> [--out FILE]
node cli.js checkCert <sample> <certFile>
node cli.js invalidate <sample> <start> <end>
node cli.js merge <sample> <certA> <certB> [--out FILE]
node cli.js certs <sample> | node cli.js info <sample>
```

错误以 JSON 写 stderr（退出码 1）：`ERR_STALE` / `ERR_CRC` / `ERR_SOURCE` / `ERR_RANGE`。

## 测试

```
node --test
```
