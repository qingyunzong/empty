# RESULTS

环境：Node.js v22.22.1，仅标准库（`node:fs` / `node:crypto` / `node:test`），单机离线。
日期：2026-10-03

## 实现

- `lib.js` — 追加式日志库。帧类型 `OBS` / `FLAG` / `TOMB`，字段含 `seq`、`id`、`ts`、`value`、`quality`、`ref`、`prevHash`、`crc`、`hash`。CRC32 自检 + SHA-256 prevHash 链；索引 `id -> 帧列表`，最新有效帧按 `(ts, seq)` 决胜；`rebuild()` 可丢索引扫描重建。API：`appendObs` / `flag` / `invalidate` / `current` / `history` / `verify`。
- `cli.js` — `append|flag|invalidate|current|history|verify|rebuild <log> ...`，结果 JSON 输出到 stdout，错误 JSON（`ERR_STALE` / `ERR_CHAIN` / `ERR_CRC` / `ERR_NOTFOUND`）输出到 stderr 并以退出码 1 结束。
- `test/acceptance.test.js` — 7 个 `node:test` 用例覆盖全部验收点。

## 测试：`node --test`（真实输出）

```
# Subtest: 1. random op sequence matches in-memory reference model
ok 1 - 1. random op sequence matches in-memory reference model
# Subtest: 2. tampering with an old OBS value is detected by the hash chain
ok 2 - 2. tampering with an old OBS value is detected by the hash chain
# Subtest: 2b. tampering without fixing crc is detected as ERR_CRC
ok 3 - 2b. tampering without fixing crc is detected as ERR_CRC
# Subtest: 3. two frames with same id and same ts order deterministically by seq
ok 4 - 3. two frames with same id and same ts order deterministically by seq
# Subtest: 4. flag after invalidate reports ERR_STALE
ok 5 - 4. flag after invalidate reports ERR_STALE
# Subtest: 5. querying an empty or unknown id reports ERR_NOTFOUND
ok 6 - 5. querying an empty or unknown id reports ERR_NOTFOUND
# Subtest: cli: append/current/history/verify and JSON errors on stderr
ok 7 - cli: append/current/history/verify and JSON errors on stderr
# tests 7
# pass 7
# fail 0
```

退出码：0

## CLI 会话（真实输出）

```
$ node cli.js append log obs7 100 42
{"seq":0,"type":"OBS","id":"obs7","ts":100,"value":42,"quality":"OK","ref":null,"prevHash":"0000000000000000000000000000000000000000000000000000000000000000","crc":"94b475e3","hash":"6b58bb7e7182361e1cbba8ab90d8062a136e6d9025545db1f747d3d0605d1b7c"}

$ node cli.js append log obs7 101 43
{"seq":1,"type":"OBS","id":"obs7","ts":101,"value":43,"quality":"OK","ref":null,"prevHash":"6b58bb7e7182361e1cbba8ab90d8062a136e6d9025545db1f747d3d0605d1b7c","crc":"ab6040cd","hash":"fb3ce64eb714b1ad6d7d9c12e7d8924ad3b282c733c37e0eb10d3672379b220c"}

$ node cli.js current log obs7
{"id":"obs7","ts":101,"value":43,"quality":"OK","seq":1,"hash":"fb3ce64eb714b1ad6d7d9c12e7d8924ad3b282c733c37e0eb10d3672379b220c"}

$ node cli.js flag log obs7 fb3ce64e... SUSPECT   # 引用当前最新帧哈希
$ node cli.js current log obs7
{"id":"obs7","ts":101,"value":43,"quality":"SUSPECT","seq":2,"hash":"71761af97353cb999b8748bae7e9fa1157d8a14ca7ea9cef6d1f8a6195b1c079"}

$ node cli.js history log obs7
[{"seq":0,"type":"OBS","id":"obs7","ts":100,"value":42,"quality":"OK","ref":null,"hash":"6b58bb7e..."},{"seq":1,"type":"OBS","id":"obs7","ts":101,"value":43,"quality":"OK","ref":null,"hash":"fb3ce64e..."},{"seq":2,"type":"FLAG","id":"obs7","ts":101,"value":null,"quality":"SUSPECT","ref":"fb3ce64e...","hash":"71761af9..."}]

$ node cli.js verify log
{"ok":true,"frames":3}

$ node cli.js current log nope   # stderr，退出码 1
{"error":"ERR_NOTFOUND"}
```

## 验收点对照

1. 随机操作序列（600 步，固定种子）与内存参考模型逐条对照 `current`/`history`，并周期性丢索引重建后复对 — 通过。
2. 改旧 OBS 值：仅改值 → `ERR_CRC`；连 CRC/自哈希一起伪造 → 下一帧 `prevHash` 断链 → `ERR_CHAIN` — 通过。
3. 同 id 同刻两帧按帧序号 `seq` 决胜，磁盘重扫后结果一致 — 通过。
4. `invalidate`（TOMB）后再 `flag` → `ERR_STALE`；`current` 忽略 TOMB，`history` 保留 — 通过。
5. 空 id / 未知 id 查询 → `ERR_NOTFOUND` — 通过。
