# Clearing-House Quota Freeze Gateway

清算所额度冻结网关。成员通过二进制帧请求 `reserve` / `commit` / `release` /
`expire`，网关按确定性规则裁决，所有判断写入 append-only 日志，输出每个请求
的 accept/reject/partial、剩余预算与 Merkle 根。

运行环境：Node.js 22，仅标准库（`node:test`、`node:crypto`、`node:fs`），单机离线。

## 命令

```
node cli.js <frames.bin> [--budget N] [--ttl T] [--fresh]
node --test
node tools/mkframes.js     # 重新生成 examples/*.bin
```

- `--budget N`：预算上限（默认 1000）。
- `--ttl T`：预留有效期，单位为虚拟 tick（默认 100）。
- `--fresh`：忽略并删除已存在的 `<frames.bin>.log`（否则视为崩溃恢复，见下文）。
- `GW_CRASH_AT=pre:N|log:N|ack:N`：在第 N 个请求的指定崩溃点模拟宕机（退出码 75）。

## 帧格式

所有整数大端。完整帧定长 38 字节：

| 偏移 | 长度 | 字段 |
|---|---|---|
| 0  | 2 | magic = `0xC1EA` |
| 2  | 2 | len（含 crc，完整帧恒为 38） |
| 4  | 1 | type：1=reserve 2=commit 3=release 4=expire 5=frag |
| 5  | 1 | flags（保留，0） |
| 6  | 8 | member（ASCII，NUL 填充） |
| 14 | 4 | reqId (uint32) |
| 18 | 4 | amount (uint32) |
| 22 | 4 | seq（链路层序号，uint32） |
| 26 | 4 | ack（对端已确认的最大 seq，uint32） |
| 30 | 4 | tick（虚拟时钟，uint32） |
| 34 | 4 | crc32（IEEE，覆盖前 34 字节） |

分片帧（type=5）：`magic|len|type|flags|member(8)|seq(4)|offset(2)|total(2)|data|crc32`，
承载某个完整帧的一段字节，由链路层重组。

## 链路层（`lib/link.js`）

- **分片**：FRAG 记录按 `seq` 重组为完整帧，偏移必须无缝拼接。
- **重传 / 去重**：相同 `seq` 的相同字节直接丢弃（计为重复）；相同 `seq` 的
  不同字节视为冲突，判为帧损坏。
- **乱序**：帧按 `seq` 顺序交付（基准 seq=1），乱序到达的帧进入重排缓冲，
  空洞补齐后按序放行；流结束时仍滞留的帧按 seq 顺序兜底交付。
- 字节流可以被任意切断（跨 `push()` 边界的半帧会等待后续字节）。

## 业务规则（`lib/core.js`）

- **预算不变量**：`used + Σ(活跃预留) ≤ budgetCap`，`remaining = cap − used − Σ活跃预留`。
- **虚拟时钟**：时间只来自帧里的 `tick`，绝不使用真实 sleep。tick 必须非递减；
  迟到的帧被钳制到当前时钟。预留的 `expireTick = 预留tick + ttl`。
- **并发裁决（同一 tick）**：同一 tick 的 reserve 批次按确定性优先级排序——
  **amount 升序 → member 字典序（码元序）→ reqId 升序**，然后依次贪心分配
  `min(请求额, 剩余预算)`。同额同刻由 member 字典序、再由 reqId 决胜。
- **reserve 可部分成功**：`granted < amount` 记为 `partial`；`granted = 0` 记为
  `reject`（reason=budget，退出码 3）。重复 reqId 的 reserve 返回缓存裁决（`dup=true`）。
- **禁止事后改判**：裁决一旦写入日志即不可撤销；后续请求不会抢占既有预留；
  恢复时按日志回放而非重新裁决。
- **commit**：只能消费**本人**（member 匹配）且**未过期**（status=active）的预留，
  `amount ≤ 剩余预留额`，可部分 commit。相同 `reqId+amount` 的重复 commit 幂等，
  绝不双扣（`dup=true`）。
- **release**：幂等。对已释放/已提交/已过期的预留再次 release 返回
  `accept released=0 noop=true`。
- **expire**：显式 expire 帧在其 tick 所在批次最先处理；TTL 到期时（批次时钟
  ≥ expireTick）自动释放并生成审计事件（`event=expire auto=true`）。
  到点即释放：tick 等于 expireTick 时预留已失效，迟到的 commit 被拒（not-active）。
- **暂存（乱序业务帧）**：commit/release/expire 先于其 reserve 到达时（reqId 未知），
  请求被暂存；对应 reserve 成交后立即按 seq 顺序补放。输入结束时仍未兑现的
  暂存请求判 `reject reason=unknown-reqid`（退出码 4）。
- **批次内处理顺序**：TTL 自动过期 → 显式 expire（按 seq）→ reserve（按优先级）
  → commit/release（按 seq）。

## Append-only 日志与 Merkle 根（`lib/log.js`）

每个判断（含重复裁决、审计事件）追加一条 JSONL 记录到 `<frames.bin>.log`：
`{n, kind, seq, tick, member, reqId, amount, status, ..., hash, root}`。
`hash = sha256(prevHash + 规范JSON)` 构成哈希链；`root` 为截至该条目的
SHA-256 Merkle 根（二叉树，奇数节点原样提升）。加载时校验哈希链与 Merkle 根，
篡改即判损坏（退出码 2）。

## 崩溃点与恢复

每个请求的处理管线为 **变更状态 → 追加日志 → 应答**，三个崩溃点：

| 崩溃点 | 位置 | 恢复行为 |
|---|---|---|
| `pre:N`  | 第 N 个请求状态变更前 | 日志无记录，恢复时确定性重算 |
| `log:N`  | 第 N 个请求日志追加后、应答前 | 日志回放补齐状态，应答由日志重建 |
| `ack:N`  | 第 N 个请求应答后 | 日志完整，恢复时跳过该请求 |

模拟崩溃以退出码 75 终止。**再次执行同一命令**（不带 `--fresh`）即进入恢复：
先回放既有日志重建状态并原样补打应答行，再继续处理剩余帧。恢复运行的完整
输出与 Merkle 根和无崩溃运行**逐字节一致**（结果唯一）。`test/recovery.test.js`
对三个崩溃点 × 多个请求位置做了穷举比对。

## 输出

每个请求一行：`#<n> tick=.. seq=.. type=.. member=.. reqId=.. amount=.. status=accept|reject|partial [granted=..|committed=..|released=..] [reason=..] [dup=true|noop=true] remaining=<剩余预算> merkle=<根>`。
自动过期产生审计行 `#- tick=.. event=expire .. auto=true ..`。
末尾一行 `summary` 汇总。退出码：

| 码 | 含义 |
|---|---|
| 0 | 正常 |
| 2 | 帧损坏（magic/len/crc/类型非法、截断、分片残缺、seq 冲突、日志篡改） |
| 3 | 有 reserve 因超预算被完全拒绝（partial 不算） |
| 4 | 输入结束时仍存在未知 reqId 的暂存请求 |

## 真实运行输出

以下输出为实际运行捕获（`node tools/mkframes.js` 重新生成样例）。

### 主流程：accept / partial / commit / release / TTL 过期 / 迟到 commit

```
$ node cli.js examples/demo.bin --ttl 50 --fresh; echo "exit=$?"
#1 tick=0 seq=1 type=reserve member=alice reqId=1 amount=400 status=accept granted=400 remaining=600 merkle=0940b73ca1216ceddeaff6a24e4b2842048fe3d8fe800cf56afde41492360d35
#2 tick=0 seq=2 type=reserve member=bob reqId=2 amount=500 status=accept granted=500 remaining=100 merkle=de1f7fbea2cf9689b4b563d1042c4822f75b29edbc8609a65a9fd46e101542b1
#3 tick=1 seq=3 type=reserve member=carol reqId=3 amount=300 status=partial granted=100 remaining=0 merkle=bb8585d48d8c5296fd85c98ca07ddc4c241ee527350e02b803222f04d80848f6
#4 tick=2 seq=4 type=commit member=alice reqId=1 amount=400 status=accept committed=400 remaining=0 merkle=28acb11647cea96092ad79a2c5b926599cd58de5fed92a0e6ee71465fad2eaf4
#5 tick=3 seq=5 type=release member=bob reqId=2 amount=0 status=accept released=500 remaining=500 merkle=b9748eed426a6dd1097cb196a95cb03882e9c82762e5557db274e5975beea5a5
#6 tick=10 seq=6 type=reserve member=erin reqId=4 amount=100 status=accept granted=100 remaining=400 merkle=941464bbbba2a559b344bbd180a18cd7321964ed5ec4ae29050f4628f05b6b50
#- tick=100 event=expire reqId=3 member=carol released=100 auto=true remaining=500 merkle=728a675986a2856cb854b11ba367e8b6721b4359bc59a88f47f930891726d29a
#- tick=100 event=expire reqId=4 member=erin released=100 auto=true remaining=600 merkle=b08ce78d420650eaabbcef3ff5bba4bd68f5655369fbe10debea3ba1d0b18a6a
#7 tick=100 seq=7 type=reserve member=frank reqId=5 amount=50 status=accept granted=50 remaining=550 merkle=e2d2899c3ab4e0e5693babd2e15ef250af5f82cca1fe5c75eb9a39d57dacd3bd
#8 tick=101 seq=8 type=commit member=erin reqId=4 amount=100 status=reject committed=0 reason=not-active remaining=550 merkle=ed41832c86737364ebf6f04338397f5766e5d11b041cf072b2a919dcc5d2ec2f
summary requests=8 used=400 reserved=50 remaining=550 merkle=ed41832c86737364ebf6f04338397f5766e5d11b041cf072b2a919dcc5d2ec2f
exit=0
```

### 分片 + 重传 + 乱序：与主流程逐字节一致

`examples/frag.bin` 与 `demo.bin` 逻辑内容相同，但帧被分片、重发并乱序投递：

```
$ node cli.js examples/frag.bin --ttl 50 --fresh > /tmp/frag.out
$ node cli.js examples/demo.bin --ttl 50 --fresh > /tmp/demo.out
$ diff /tmp/demo.out /tmp/frag.out && echo IDENTICAL
IDENTICAL
```

### 并发 reserve 超预算（同额同刻按 member 字典序决胜）

```
$ node cli.js examples/overbudget.bin --fresh; echo "exit=$?"
#1 tick=0 seq=2 type=reserve member=alice reqId=1 amount=600 status=accept granted=600 remaining=400 merkle=f8152dafa9573ebf0c1d50b3eaa9e2159552dfdd7343acc27e7811f353e65029
#2 tick=0 seq=3 type=reserve member=bob reqId=2 amount=600 status=partial granted=400 remaining=0 merkle=81116759aa694733103e4db09dac62844cd4223a5fbc0008ea3f014542f2559d
#3 tick=0 seq=1 type=reserve member=carol reqId=3 amount=600 status=reject granted=0 reason=budget remaining=0 merkle=840c963d7c7a29b5009a55c05151a2498a291b5d0a2ee9fd6b07c129d145fe46
summary requests=3 used=0 reserved=1000 remaining=0 merkle=840c963d7c7a29b5009a55c05151a2498a291b5d0a2ee9fd6b07c129d145fe46
exit=3
```

注意：carol 的帧 seq=1 最先到达，但同额同刻按 member 字典序裁决，alice 优先。

### 未知 reqId

```
$ node cli.js examples/unknown.bin --fresh; echo "exit=$?"
#1 tick=0 seq=1 type=commit member=alice reqId=99 amount=10 status=reject reason=unknown-reqid remaining=1000 merkle=53ebc79d2087d5b7a1d0c4d5035d3defdae81f7f884eae1b46a0b469cf883039
summary requests=1 used=0 reserved=0 remaining=1000 merkle=53ebc79d2087d5b7a1d0c4d5035d3defdae81f7f884eae1b46a0b469cf883039
exit=4
```

### 帧损坏

```
$ node cli.js examples/corrupt.bin --fresh; echo "exit=$?"
error: corrupt frame: crc32 mismatch
exit=2
```

### 崩溃与恢复（崩溃点 log:4）

```
$ GW_CRASH_AT=log:4 node cli.js /tmp/recover.bin --ttl 50 --fresh; echo "exit=$?"
#1 tick=0 seq=1 type=reserve member=alice reqId=1 amount=400 status=accept granted=400 remaining=600 merkle=0940b73c...
#2 tick=0 seq=2 type=reserve member=bob reqId=2 amount=500 status=accept granted=500 remaining=100 merkle=de1f7fbe...
#3 tick=1 seq=3 type=reserve member=carol reqId=3 amount=300 status=partial granted=100 remaining=0 merkle=bb8585d4...
exit=75                      # 第 4 个请求已写日志、未应答即宕机（盘上日志 4 行）
$ node cli.js /tmp/recover.bin --ttl 50 | tail -1; echo "exit=$?"
summary requests=8 used=400 reserved=50 remaining=550 merkle=ed41832c86737364ebf6f04338397f5766e5d11b041cf072b2a919dcc5d2ec2f
exit=0                       # 恢复后 Merkle 根与无崩溃运行完全一致
```

## 测试（`node --test`，43 个子测试）

| 文件 | 覆盖 |
|---|---|
| `test/frame.test.js` | 编解码往返、CRC 校验值、篡改/坏 magic/非法字段、分片编解码 |
| `test/link.test.js` | 去重、乱序重排、分片重组（交叉/重复/冲突）、字节级切分、截断 |
| `test/core.test.js` | **验收 1** 并发超预算+并列决胜、**验收 2** 重复 commit 不双扣、**验收 3** 乱序 release 暂存、**验收 4** 虚拟时钟 expire+迟到 commit、release 幂等、禁止改判、日志哈希链 |
| `test/enumerate.test.js` | **验收 5**：6 请求全排列 720 种到达序结果一致；8 请求全部 255 个子集对照暴力预算分配；200 组确定性 fuzz 不变量 |
| `test/recovery.test.js` | 三崩溃点 × 多位置穷举恢复结果唯一；多次崩溃连续恢复；日志篡改拒绝 |
| `test/cli.test.js` | 退出码 0/2/3/4、输出格式、截断流、恢复重放一致性 |

## 目录结构

```
cli.js            命令行入口（参数解析、退出码映射）
lib/frame.js      二进制帧编解码、CRC32、分片
lib/link.js       链路层：重组、去重、重排
lib/core.js       业务核心：预算、优先级、暂存、虚拟时钟 expire、日志回放
lib/log.js        append-only 日志、哈希链、Merkle 根
lib/run.js        网关运行器（CLI 与测试共用）
lib/format.js     输出行格式化
tools/mkframes.js 生成 examples/*.bin
examples/         样例帧流
test/             node:test 测试
```
