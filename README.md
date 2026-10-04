# qlin — 离线质量谱系库

Node.js 22、仅标准库、`node:test`。批次记录（lot、父批次、工序、检验结论）按块编码，
每块带 CRC32；清单保存每块 SHA-256；索引支持按 lot 随机定位。解码器增量加载块并维护
有向谱系图，查询返回可独立复验的路径证书。

## 文件布局（`<db>` 为库前缀）

- `<db>.dat` — 8 字节 magic `QLIN0001` + 块序列；块 = `u32 长度 | u32 CRC32 | payload(JSON 行)`
- `<db>.manifest.json` — 每块 `{id, offset, length, sha256}`；更新走临时文件 + rename，原子生效
- `<db>.index.json` — `lot -> {block, offset, length, parents}`，按 lot 随机定位
- `<db>.pending` — 未封块记录，`seal` 时落块并清除

## CLI

```
node cli.js init <db> [--block-records N]
node cli.js add <db> --lot L [--parents a,b] [--op OP] [--verdict V]
node cli.js seal <db>
node cli.js ancestors <db> <lot>
node cli.js descendants <db> <lot>
node cli.js paths <db> <from> <to>     # 输出路径证书数组
node cli.js verify <db> <cert.json>    # 独立复验证书
```

## 证书

`paths` 返回 `qlin-path-cert`：路径、经过的块 id、每条记录的偏移/长度、每块边界哈希
（SHA-256）。`verify` 只依赖清单与数据文件重算哈希并核对边，不依赖索引与内存图。
`ancestors`/`descendants` 返回 `qlin-set-proof`，同样可复验。

## 错误码

- `E_CRC` — 块哈希/CRC 校验失败；经过损坏块的查询直接报错，不给猜测路径，无关批次不受影响
- `E_INDEX` — 索引与清单/块内容不一致
- `E_MANIFEST` — 证书与清单不一致
- `E_CERT` — 证书内容自洽性校验失败
- `E_NOTFOUND` / `E_EXISTS` / `E_ARGS`

## 测试

```
node --test
```

覆盖：≤10 批次随机 DAG 与独立 DFS 枚举的路径集合一致；单块字节翻转后隔离范围精确；
追加块并原子更新清单后旧证书可复验、新证书包含新块；索引/清单不一致报 `E_INDEX`；
篡改证书复验失败；CLI 端到端。
