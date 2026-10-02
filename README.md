# 清算所额度冻结网关

Node.js 22、仅标准库、单机离线。成员通过二进制帧发起 `reserve` / `commit` / `release` / `expire`，
网关完成链路层可靠投递（重传去重、乱序暂存、分片重组）、预算约束下的额度冻结、
虚拟时钟到期释放、append-only 审计日志与崩溃恢复。

## 运行

```bash
node genframes.js frames.bin   # 生成演示帧流
node cli.js frames.bin         # 处理帧流，逐请求输出判定
node --test                    # 全部测试
```

环境变量：`CH_BUDGET`（默认 1000）、`CH_TTL`（预留存活虚拟刻，默认 100）、
`CH_LOG`（WAL 持久化路径，存在则先恢复）、`CH_CRASH_AT` + `CH_CRASH_POINT`
（`before_state|after_log|after_reply`，崩溃注入）。

## 帧格式（36 字节，大端）

| 偏移 | 字段 | 类型 | 说明 |
|---|---|---|---|
| 0 | len | u16 | 帧总长，恒为 36 |
| 2 | type | u8 | 1=RESERVE 2=COMMIT 3=RELEASE 4=EXPIRE |
| 3 | flags | u8 | 保留，须为 0 |
| 4 | member | 8B | ASCII，NUL 填充 |
| 12 | reqId | u32 | 成员内唯一请求号 |
| 16 | amount | u64 | 金额；EXPIRE 帧复用为目标虚拟时刻 |
| 24 | seq | u32 | 每成员发送序号，从 1 开始 |
| 28 | ack | u32 | 信息性字段 |
| 32 | checksum | u32 | 对字节 0..32 的 CRC32 |

## 链路层

- **分片**：`Deframer` 是流式解析器，帧可按任意字节边界切分（CLI 以 13 字节块喂入验证）。
- **重传去重**：`seq < expected` 判定为重传，重放缓存应答，不重复记账、不重复写日志。
- **乱序暂存**：`seq > expected` 进入 holdback 队列，缺口补齐后按序放行；
  业务层另有 pending-release：release 先于其 reserve 到达时按 reqId 暂存，reserve 到达即冲抵。
- **虚拟时钟**：只由 EXPIRE 帧推进（amount=目标时刻），无任何真实 sleep/定时器。

## 业务核心

- **预算上限**：`budgetLeft = budget - 活跃预留 - 已提交`；reserve 可部分成功
  （`accept` / `partial` / `reject`），授予额 = `min(请求, 剩余预算)`。
- **并列规则**：`Engine.comparePriority` 按 (tick, amount) 排序，同额同刻按 member 字典序、
  再按 reqId 决胜；expire 审计事件即按此序生成。授权一旦做出绝不事后改判
  （测试以前缀性质验证：任意前缀的分配不被后续请求改变）。
- **commit**：只能消费本人未过期预留，超出剩余部分截断；已全额 commit 后再 commit
  是幂等空操作（不双扣）；过期/已释放/未知 reqId 一律 reject。
- **release**：幂等；重复 release、对已关闭预留 release 均为空操作。
- **expire**：虚拟钟推进到目标时刻，所有 `expiresAt <= now` 的预留被释放，
  每条生成 `event=EXPIRED` 审计事件；迟到的 commit 以 `reason=expired` 拒绝。

## 日志、Merkle 与崩溃恢复

每个判定（重传除外）以 WAL 方式写入 append-only 日志，处理流水线：

```
plan -> [崩溃点 before_state] -> 写日志 -> [崩溃点 after_log] -> 改状态 -> 应答 -> [崩溃点 after_reply]
```

恢复 = 从日志确定性重放（`Engine.recover`），三个崩溃点下恢复结果唯一；
每请求输出当时日志的 Merkle 根（SHA-256，奇数节点复制提升）。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 正常 |
| 2 | 帧损坏（checksum/len/截断），立即中止 |
| 3 | 有 reserve 因超预算被完全拒绝（优先级高于 4） |
| 4 | 未知 reqId（commit 未识别，或流结束仍有未兑现的暂存 release） |
| 64 | 用法错误 |
| 70 | 注入的模拟崩溃 |

## 真实输出

`node genframes.js frames.bin && node cli.js frames.bin`（退出码 3）：

```
#000 RESERVE member=ALICE req=1 want=600 got=600 decision=accept budget=400 now=0 merkle=2358268f89a905f1766c7c3b2d4847466acf06d892df24b4a9aff7e0ea6c2b70
#001 RESERVE member=BOB req=1 want=700 got=400 decision=partial budget=0 now=0 merkle=8179ddfe26318941b9e3f19d35119961db483a54ecfc5d4b026e0db76eae8ad9
#002 RESERVE member=CAROL req=1 want=100 got=0 decision=reject budget=0 now=0 merkle=7066c9cb460b1be10e121dff03d4522f217c4e70a65003300ef67b816434d998
#003 COMMIT member=ALICE req=1 want=600 got=600 decision=accept budget=0 now=0 merkle=cd2c70311bb2193f6b867235f86a000e7b63def296f3c148d713a0e33b6166dd
#004 COMMIT member=ALICE req=1 want=600 got=600 decision=accept budget=0 now=0 merkle=cd2c70311bb2193f6b867235f86a000e7b63def296f3c148d713a0e33b6166dd [dup]
#005 RELEASE member=BOB req=1 want=400 got=400 decision=accept budget=400 now=0 merkle=6bc63657a41e6963ec3873c0063f92ac229a5b525aaafd6dacc10e1fa0d03476
#006 RELEASE member=DAVE req=2 want=200 got=0 decision=buffered budget=400 now=0 merkle=debc8d9a6d399571d6ee70d626c409ceb50c20f238c52244e8693af6b6b69f05
#007 RESERVE member=DAVE req=2 want=200 got=200 decision=accept budget=400 now=0 merkle=cc561b50a3343270eb1bd9c125ea894d833b0d344609c74c6bf90e2a2759ff5a
#008 RESERVE member=ERIN req=1 want=100 got=100 decision=accept budget=300 now=0 merkle=fea1eb663dc13cc8a3f5f020619ae714480a3003f759325cf75a35da25c518be
#009 COMMIT member=ERIN req=1 want=50 got=50 decision=accept budget=300 now=0 merkle=4c0bf0dbb09f5eb0f1897557c42dc52afd96f7c01766806437fdd86b5dc08566
#010 RESERVE member=ALICE req=2 want=100 got=100 decision=accept budget=200 now=0 merkle=f20732ad410819e41cdbbb2a041a7b2e964c92e6cdb27a799892ab71f483a56a
#011 EXPIRE member=SYS req=0 want=0 got=0 decision=accept budget=350 now=100 merkle=8ed158d13108f8a7528234b43b24234daa896a836e3c8c128f9cfe222411785e
     event=EXPIRED member=ERIN req=1 released=50 now=100
     event=EXPIRED member=ALICE req=2 released=100 now=100
#012 COMMIT member=ALICE req=2 want=100 got=0 decision=reject reason=expired budget=350 now=100 merkle=40a07163b8bca6ddba242054b8743c6350090c47cfaf81b66f46b2a774df348c
#013 COMMIT member=EVE req=9 want=50 got=0 decision=reject reason=unknown-reqId budget=350 now=100 merkle=506693eace29f557d833b6be0fa9cc5bb4845b341006f81c9ef157f99fbe4ee7
done: decisions=13 flags=over_budget,unknown_req merkle=506693eace29f557d833b6be0fa9cc5bb4845b341006f81c9ef157f99fbe4ee7
```

崩溃注入与恢复（`CH_CRASH_AT=4 CH_CRASH_POINT=after_log`，先 exit 70，恢复后输出与无崩溃运行逐字节一致）：

```
$ CH_LOG=/tmp/gw.log CH_CRASH_AT=4 CH_CRASH_POINT=after_log node cli.js frames.bin
...
crash: simulated crash at after_log on decision #4        # exit=70
$ CH_LOG=/tmp/gw.log node cli.js frames.bin               # 从 WAL 恢复
...（stdout 与上方无崩溃运行完全相同，diff 为空）
done: decisions=13 flags=over_budget,unknown_req merkle=506693eace29f557d833b6be0fa9cc5bb4845b341006f81c9ef157f99fbe4ee7
```

`node --test`：

```
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 10767.080516
```

## 测试与验收对照

| 验收项 | 测试 |
|---|---|
| 并发 reserve 总额超预算 | `test/engine.test.js` accept/partial/reject；`test/cli.test.js` 退出码 3 |
| 重复 commit 不双扣 | `test/engine.test.js`、`test/cli.test.js`（重传 dup + 已结清幂等） |
| 乱序 release 先于 reserve 被暂存 | `test/engine.test.js`（业务暂存）、`test/link.test.js`（holdback） |
| 虚拟时钟 expire 与迟到 commit | `test/engine.test.js`、`test/cli.test.js` |
| ≤8 请求枚举对照暴力预算分配 | `test/bruteforce.test.js`（3^1..3^8 全枚举 + 前缀性质 + 确定性） |
| 三崩溃点恢复唯一 | `test/recovery.test.js`（引擎级全点位）、`test/cli.test.js`（CLI/WAL 级） |
| 帧损坏 exit 2 | `test/cli.test.js`（checksum、截断）、`test/link.test.js` |

## 文件

- `frame.js` 帧编解码 + CRC32
- `link.js` 流式解帧（分片）+ 每成员可靠会话（去重/乱序暂存）
- `engine.js` 业务核心：预算、虚拟时钟、WAL、崩溃点、确定性恢复
- `log.js` append-only 日志 + Merkle 树
- `gateway.js` 链路层与引擎的粘合（应答缓存/恢复应答）
- `cli.js` 命令行入口（`runGateway` 可进程内复用）
- `genframes.js` 演示帧流生成器
