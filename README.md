# audit — 结算事件流最小补丁与审计工具

Node.js 22，仅标准库，单机离线。

## 命令

```
audit verify <log.jsonl>
audit patch <log.jsonl> <fix.json> --out <new.jsonl> --cert <cert.json>
audit check <old.jsonl> <new.jsonl> <cert.json>
audit recover <new.jsonl> <cert.json>
```

## 事件与链

- 每行一个事件：`{seq, prevHash, hash, body}`。
- `hash = sha256(prevHash + canonical(body))`；`canonical` 为键递归排序、无空白、数组保序的 JSON。
- 创世事件 `prevHash = ""`；`seq` 必须为 1..N 连续。
- 链根 root = 末事件 hash（空日志为 `""`）。

## fix.json

只允许 `patchOps`，两种操作：

- `{"op":"replaceBody","seq":k,"fields":{...}}` — 浅合并字段进 body。
- `{"op":"void","seq":k,"reason":"..."}` — 逻辑作废，body 变为墓碑 `{voided:true,reason}`，事件保留原位。

禁止改 `seq`/`prevHash` 顺序；补丁后自首个变更点起重算链。未知 op、越界 seq、重复 seq 均以 exit 2 拒绝。

## 证书 cert.json

`{version, oldRoot, newRoot, changedSeqs, unchangedRanges, changes:[{seq,op,beforeHash,afterHash,fields|reason}]}`。
`unchangedRanges` 必须恰为 `changedSeqs` 在 1..N 上的补集区间。`check` 逐项核对：
未变更事件的 body 深相等；变更事件的 before/after 哈希与 op 语义（墓碑形状、replaceBody 字段）匹配。
失败时错误信息定位首个 seq（`[first seq: k]`）。

## 退出码

| code | 含义 |
|---|---|
| 0 | 成功 |
| 2 | 用法/输入非法 |
| 9 | 断链（hash/prevHash/seq 连续性校验失败） |
| 10 | 越权改 seq（新旧日志 seq 序列不一致） |
| 11 | 证书与文件不符 |
| 12 | 崩溃态（old/partial），拒绝静默混用 |

## 崩溃恢复协议

`patch` 持久化顺序：写 `new.tmp`、写 `cert.tmp`（均 fsync）→ rename `new.tmp` → rename `cert.tmp` → 目录 fsync。
任一故障点崩溃后，`recover` / `check` 判定三态：

- **old**：两个终态文件都不存在。原件未被触碰；若残留 `.tmp`，提示 `rm` 后重跑。
- **new**：两个终态文件都在。补丁已完整应用，运行 `check` 复核。
- **partial**：只 rename 了一个。绝不混用，给出 `rm` 回滚指令后重跑 `patch`。

## 测试

```
node --test
```

覆盖：正常替换并验证、断链拒绝（exit 9）、证书篡改检出（exit 11，含重算链+伪造 newRoot 的复合伪造）、
越权 seq（exit 10）、崩溃恢复三态、seq≤10 全量 2^10 修复子集对照 unchangedRanges。
