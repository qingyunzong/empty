# evlog — 合规证据链追加日志

仅依赖 Node.js 标准库(>=18,开发于 Node 22)。提供可崩溃恢复的追加式证据日志:
日志分块落盘,每块含序号、`prevHash`、payload、CRC32 与提交标记;旁路检查点文件
(`<log>.ckpt`)记录最后提交序号与根哈希,可从日志重建。

## 格式

```
[4B magic "EVL1"][4B LE bodyLen][JSON body][4B LE CRC32(magic|len|body)]
```

- 数据块 `{t:"d", seq, prevHash, payload}` — `append` 写入
- 提交块 `{t:"c", seq, root}` — `commit` 写入,封印其前的待定数据块
- 块哈希 = `sha256({seq, prevHash, payload})`,创世根为 64 个 `0`

## API (`lib/evlog.js`)

- `open(path)` → 句柄(记录已提交基线与链头)
- `append(h, payload)` → seq(写数据块,未提交)
- `commit(h)` → 写提交块 + fsync + 原子更新检查点;基于旧根时抛 `ERR_STALE_ROOT`
- `recover(path)` → 截断到最后完整提交,丢弃未提交/半写数据,重建检查点(幂等)
- `verify(path)` → 严格校验已提交链;错误码 `ERR_CRC` / `ERR_FORK` / `ERR_SEQ`
- `tail(path, n)` → 最近 n 条**已提交**记录

## CLI

```
node cli.js append <log> <payload...>
node cli.js commit <log>
node cli.js recover <log>
node cli.js verify <log>
node cli.js tail <log> [n]
```

成功时 stdout 输出 JSON;失败时 stderr 输出 `{"error":"ERR_...","message":"..."}` 并以退出码 1 结束。

## 测试

```
node --test
```
