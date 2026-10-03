# evlog — 合规证据链追加日志

Node.js 22、仅标准库、单机离线。提供可崩溃恢复的追加日志库与 CLI:
日志分块(序号 / prevHash / payload / CRC / 提交标记)+ 检查点文件(最后提交序号与根)。

## 格式

- 每块一行 JSON:`{"seq":N,"prevHash":"<sha256>","payload":...,"committed":bool,"crc":"<crc32>"}`
- `crc` = CRC-32(IEEE,自实现)覆盖 `{seq,prevHash,payload,committed}` 的规范化 JSON
- 块哈希 = 整行(不含换行)的 SHA-256;`prevHash` 链接前一块,创世为 64 个 `0`
- `commit` 追加一个 `committed:true`、`payload:null` 的提交标记块,随后原子写
  检查点 `<log>.checkpoint`(tmp + fsync + rename),内容 `{"lastSeq":N,"root":"<hash>"}`

## 语义

- `append` 立即落盘(fsync)但 `committed:false`;未提交部分在 `recover` 中截断丢弃
- `commit` 先校验句柄基准根与当前已提交根一致,否则 `ERR_STALE_ROOT`(并发双句柄,
  后提交者基于旧根即被拒绝);提交块写半 → `recover` 回到最后一个完整提交
- `recover` 顺序扫描,首个不完整/非法块即崩溃点,截断到最后完整提交块,
  并从日志重建检查点(检查点过旧或损坏均可恢复);空日志幂等
- `verify` 严格校验整条链:CRC 错误 → `ERR_CRC`,序号回退 → `ERR_SEQ`,
  prevHash 断链/检查点与日志分歧 → `ERR_FORK`
- `tail [n]` 只返回已提交区间的数据块(不含提交标记)

## CLI

```
node cli.js append <log> <payload...>
node cli.js commit <log>
node cli.js recover <log>
node cli.js verify <log>
node cli.js tail <log> [n]
```

成功:JSON 到 stdout,退出码 0。失败:JSON `{"error":"ERR_*","message":...}` 到
stderr,退出码 1。

## 库

```js
const { open, recover, verify, tail } = require('./lib/evlog');
const h = open('log');       // 句柄记录基准根
h.append('payload');         // 未提交块
h.commit();                  // 可能抛 ERR_STALE_ROOT
recover('log'); verify('log'); tail('log', 10);
```

## 测试

```
node --test
```
