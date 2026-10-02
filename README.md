# cert-store

检验站离线质量证书存储：按段存储、段内位置索引（varint 压缩）、哈希链
manifest、可验证包含/排除证明。仅 Node.js 22 标准库，无密钥、无网络。

## 布局

```
store/
  segments/<id>.json    段数据 {id, epoch, text, index, hash}
  quarantine/           recover 隔离的撕写/未提交段
  manifest.json         {version, epoch, segments[], tombstones[], head}
  manifest.json.tmp     manifest 原子替换的临时文件（崩溃残留）
```

- 段内索引：`token -> base64(varint(位置差分))`，词项为单个 CJK 字或
  ASCII 词；短语查询要求词项位置相邻。
- 哈希链：`head = H(H(...H(epoch | seg1 | seg2 ... | tomb1 ...)))`，
  每段哈希与每个墓碑（瘦身视图：id/segHash/pred/succ/epoch）都链入。
- 删除：先把墓碑（前驱、后继、epoch、删除前链状态 `before`）提交进新
  manifest，再删段文件。`prove` 对已删段同时给出新排除证明与旧包含证明。
- 信任模型：manifest head 为信任根，第三方用 `lib/verify.js` 纯函数验证，
  无需访问存储、密钥或网络。

## CLI

```
node cli.js [--dir STORE] put <id> [--file <path> | --text <text>]
node cli.js [--dir STORE] del <id>
node cli.js [--dir STORE] query <短语...>
node cli.js [--dir STORE] prove <id>
node cli.js [--dir STORE] recover
```

错误码（stderr，退出码 1）：`E_CHAIN` 链校验失败、`E_TORN` 段未入链
（撕写/未提交）、`E_ABSENT` 段不存在。

## 故障模型与恢复

故障点：写段数据后、写 manifest 前、替换 manifest 中。

- 段文件不在 manifest 链中（撕写或未提交）→ 不计入查询；`recover` 移入
  `quarantine/` 并记录 `reason=torn-write|uncommitted`。
- `manifest.json.tmp` 残留 → `recover` 丢弃，保留最后完整链。
- 任何一字节篡改 → 所有操作（含 recover）报 `E_CHAIN`，状态不迁移。

## 测试

`node --test` 真实结果（2026-10-03，Node v22.22.1）：

```
ok 1 - varint delta postings round-trip
ok 2 - 1. brute-force inclusion/exclusion on small corpus
ok 3 - 2. fault injection: torn write, uncommitted segment, interrupted manifest replace
ok 4 - 3. after deletion, prove yields new exclusion and old inclusion
ok 5 - 4. one-byte tamper -> E_CHAIN and state does not migrate
ok 6 - 5. CLI end-to-end: put/query/prove/del/recover
# pass 6 / fail 0
```
