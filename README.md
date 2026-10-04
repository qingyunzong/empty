# audit-terminal

审计追踪终端库与 CLI。Node.js 22,仅标准库,单机离线。操作以二进制帧提交,
写入 append-only 哈希链日志,定期签发可验证 checkpoint,支持事务撤销(追加
inverse entry,日志永不截断)。

## 命令

```sh
node cli.js <frames.bin>              # 消费帧流,输出执行结果/拒绝原因/root
node cli.js verify <checkpoint.json>  # 校验证书:链完整性 + count/root/headHash + HMAC 签名
node --test                           # 全部测试(含 5 条验收)
node scripts/make-demo.js             # 重新生成 examples/demo/frames.bin
```

运行目录(默认 cwd,可用 `AT_DIR` 覆盖)下的文件:

| 文件 | 作用 |
| --- | --- |
| `audit.log` | append-only JSONL 日志,每行一个 entry,`prevHash` 链接 |
| `audit.index.json` | 派生索引(state/expectedSeq/rejected),崩溃后从日志重建 |
| `checkpoint.json` | 定期签发(默认每 4 条,`AT_CHECKPOINT_EVERY` 可调)+ 运行结束签发 |
| `terminal.key` | HMAC-SHA256 签名密钥,首次运行生成 |
| `evidence.log` | 被拒绝写(如过期租约迟到写)的证据,含原始帧哈希 |

## 二进制帧格式(大端)

```
magic      u16   'AT' (0x4154)
len        u32   帧总长(含 magic 与 crc)
version    u8    1
actorLen   u8
cmdLen     u8
opId       16B   幂等键,重传去重依据
seq        u64   每 actor 单调序号
ack        u64   客户端捎带确认,记录在 entry 中
leaseUntil u64   租约截止(虚拟时钟)
prevHash   32B   客户端观察到的链头 SHA-256
argsLen    u16
actor      u8[actorLen]  utf8
cmd        u8[cmdLen]    utf8: set | del | undo | noop
args       u8[argsLen]   utf8 JSON
crc32      u32   对 magic..args 的 CRC-32/IEEE
```

`FrameStream` 按 `len` 重组任意分帧;坏 magic/长度/CRC/截断尾帧抛 `FrameError`。

## 协议语义

- **重传/去重**:`opId` 已应用 → 返回缓存结果 `duplicate`,日志不增长;已被拒的
  `opId` 重传 → 重放同一拒绝。
- **乱序暂存**:`prevHash != headHash` 或 `seq` 有缺口的帧进入暂存队列;每提交一条
  后扫描队列,满足 `prevHash == head && seq == 期望` 的帧按到达顺序补提交。
- **虚拟时钟与租约**:虚拟时钟 = 已提交 entry 数(由日志导出,崩溃可恢复)。
  帧在提交时刻 `clock > leaseUntil` → 拒绝(`lease_expired`),写 `evidence.log`
  保留证据(含原始帧 SHA-256),并消耗该 `seq` 使同 actor 后续帧不被永久阻塞。
- **多 actor 线性化**:可提交条件 = 租约有效 ∧ `seq` 为 actor 下一序号 ∧
  `prevHash` 匹配链头;多个可提交帧按到达顺序线性化,日志顺序即线性化顺序。
- **事务撤销**:`undo {opId}` 追加 `kind:"inverse"` entry,效果 = 恢复目标 entry
  的 `prevValue`;内含 `proof:{targetHash, targetIndex, targetStateBefore}` 证明其
  前置状态,校验时重算。撤销 inverse entry 即重放原效果(撤销之撤销)。日志只增不删。

## 崩溃点与恢复

三个崩溃注入点(测试用 `AT_CRASH_AFTER` + `AT_CRASH_AT` 触发,退出码 70):

1. `parse` — 帧解析后、提交前:日志无此帧,重放整流即可(幂等)。
2. `flush` — 日志落盘(fsync)后、索引更新前:恢复时索引与日志不一致 → 重建。
3. `index` — 索引更新后:恢复时校验 `count/headHash` 一致则直接信任。

恢复:打开日志时截断撕裂尾行,重放验证哈希链与 inverse proof,重建/校验索引;
重放同一 `frames.bin` 因 `opId` 去重而收敛到同一 `root`。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 2 | 帧错误(坏 magic/长度/CRC/截断) |
| 3 | 发生租约过期拒绝(处理继续,证据已保留) |
| 5 | 哈希链断裂 / entry 哈希不符 / inverse proof 无效 |
| 1 | verify 其他不一致(count/root/head/签名) |
| 70 | 崩溃注入(仅测试) |

## 真实输出

`node scripts/make-demo.js && AT_DIR=examples/demo node cli.js examples/demo/frames.bin`
(7 帧:乱序 undo、过期租约、重传;退出码 3):

```
{"opId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","actor":"alice","status":"applied","index":0,"hash":"87a5eadbe82fba972e3e44f4c632ac623337df84482768c88c23f3533e14a4a6","cmd":"set","result":{"ok":true}}
{"opId":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","actor":"alice","status":"applied","index":1,"hash":"18fc49b26e1e27f6a3aa9a4135ede6231e8f2cd60bd857b1978e16a5fcf259be","cmd":"set","result":{"ok":true}}
{"opId":"dddddddddddddddddddddddddddddddd","actor":"alice","status":"buffered"}
{"opId":"cccccccccccccccccccccccccccccccc","actor":"bob","status":"applied","index":2,"hash":"b0db433fdbe6b227028846f66fd814566fe66b62e9657bb8d6bcc0867076400e","cmd":"set","result":{"ok":true}}
{"opId":"dddddddddddddddddddddddddddddddd","actor":"alice","status":"applied","index":3,"hash":"20ee4bf3f63022477740b3d3d46a6bd38a72b1ef3e96963dc75a370bfd627303","cmd":"undo","result":{"ok":true,"undoOf":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}
{"opId":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","actor":"bob","status":"applied","index":4,"hash":"ef284b4cf858eaf65c547fa9a5d3b4b59b0650802704c047878c8c8d376e2516","cmd":"del","result":{"ok":true}}
{"opId":"ffffffffffffffffffffffffffffffff","actor":"alice","status":"rejected","reason":"lease_expired"}
{"opId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","actor":"alice","status":"duplicate","index":0,"hash":"87a5eadbe82fba972e3e44f4c632ac623337df84482768c88c23f3533e14a4a6"}
{"root":"2f8e5b4998e8abecc04a1563b1fd4305f9bcefe1f396dce41964216488323432","count":5,"headHash":"ef284b4cf858eaf65c547fa9a5d3b4b59b0650802704c047878c8c8d376e2516","checkpoint":"examples/demo/checkpoint.json","leaseExpired":1}
```

`node cli.js verify examples/demo/checkpoint.json`(退出码 0):

```
{"ok":true,"problems":[],"count":5,"root":"2f8e5b4998e8abecc04a1563b1fd4305f9bcefe1f396dce41964216488323432","headHash":"ef284b4cf858eaf65c547fa9a5d3b4b59b0650802704c047878c8c8d376e2516","sig":"valid"}
```

`node --test`:

```
# tests 6
# pass 6
# fail 0
```

## 验收对照

1. **重放同 opId** — `test/terminal.test.js` "acceptance 1" + CLI duplicate 测试。
2. **乱序 prevHash 暂存** — `test/terminal.test.js` "acceptance 2"(3,1,4,2 送达,
   收敛到参考链)。
3. **撤销后再撤销** — `test/terminal.test.js` "acceptance 3"(3 条 entry,inverse 的
   inverse 恢复原值,proof 链完整)。
4. **三故障点恢复** — `test/recovery.test.js`:parse/flush/index × 第 2/5 帧崩溃,
   恢复后 root 与无故障参考运行一致,checkpoint 可验证。
5. **≤8 操作枚举交错** — `test/enum.test.js`:n=1..8,双 actor,枚举全部 n! 种送达
   排列(8! = 40320),终态哈希链与参考串行器逐一相等。
