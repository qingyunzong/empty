# qgenealogy

离线质量谱系库与 CLI。Node.js 22，仅标准库，测试使用 `node:test`。

## 数据模型

批次记录：`{ "lot": "L1", "parents": ["L0"], "op": "mix", "result": "pass" }`
（`parents` 为父批次 lot 列表，`op` 为工序，`result` 为检验结论）。
有向谱系图的边由子批次指向父批次。

## 存储格式

- **数据文件**：块序列。每块 16 字节头（magic `QGB1`、块 id、载荷长度、
  载荷 CRC32）+ NDJSON 记录载荷。
- **清单**（`manifest.json`）：每块的 SHA-256，按块 id 排列；追加时整体原子替换
  （临时文件 + rename），旧块哈希不变。
- **索引**（`index.json`）：每块的文件偏移/长度、lot → (块 id, 记录偏移)、
  父→子反向边，支持按 lot 随机定位。

解码器只预读清单与索引；数据块按需逐块读取（`fs.readSync` 定位读取并缓存），
从不一次读入全文件。

## 错误码

- `E_CRC`：块载荷 CRC32 或块哈希与清单不符（块损坏）。经过损坏块的查询直接
  报错，不返回猜测路径；无关块不受影响。
- `E_INDEX`：索引与清单/文件布局不一致。
- `E_CERT` / `E_MANIFEST` / `E_NOTFOUND` / `E_FORMAT` / `E_USAGE`。

## 路径证书

`paths` 查询为每条路径产出证书：经过的块 id、块内记录偏移、记录哈希、
块哈希、边界哈希（首末记录哈希）以及清单前缀承诺（块数 + 前缀哈希）。
证书可用 `verify` 独立复验；追加新块后旧证书仍然有效（前缀承诺不变），
新证书覆盖新块。

## CLI

```
node bin/cli.js encode      --records R.json --data D.qg --manifest M.json --index I.json [--blockSize N]
node bin/cli.js append      --records R.json --data D.qg --manifest M.json --index I.json [--blockSize N]
node bin/cli.js ancestors   --data D.qg --manifest M.json --index I.json --lot LOT
node bin/cli.js descendants --data D.qg --manifest M.json --index I.json --lot LOT
node bin/cli.js paths       --data D.qg --manifest M.json --index I.json --from A --to B [--certs OUT.json]
node bin/cli.js verify      --data D.qg --manifest M.json --index I.json --cert CERT.json
```

成功退出码 0；失败退出码 1，stderr 打印错误码。

## 库 API

```js
const { encode, appendRecords, Decoder, verifyCertificate } = require('./src');
```

## 测试

```
node --test
```
