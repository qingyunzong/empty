# auditlog

单机离线、仅标准库（Node.js 22）的多租户审计追加日志库与 CLI。
结算事件以页为单位追加到本地日志，提交点是 `fsync`；页与页之间用
SHA-256 哈希链连接，形成可验证的证书（certificate）。调度器在租户间做
配额与公平调度：每秒速率配额（令牌桶）+ 磁盘硬配额，等待时间按 aging
加法提升权重以抑制饥饿，但 aging 永远不能突破硬配额。

## 运行

```sh
node --test          # 全部测试（29 个用例，6 个测试文件）
node bin/auditlog.js append  --log <dir> --input events.jsonl [--config cfg.json]
node bin/auditlog.js recover --log <dir> [--config cfg.json]
node bin/auditlog.js verify  --log <dir> [--config cfg.json]
```

- 输入：JSONL，每行 `{"tenant": "a", "seq": 0, "data": ...}`（`seq` 为租户内从 0 开始的连续序号）。
- 输出：JSON，含 `stats`、`root`（哈希链头，空日志为 32 字节全零的 genesis）、`violations`；
  `recover` 额外输出 `quarantine` 证明列表。
- 退出码：`0` 成功；`1` 一般错误（含 `QUOTA`/`SEQ_GAP`/`READONLY` 等致命错误）；
  `2` 数据损坏（`verify` 发现篡改，或 `append` 遇到待恢复的撕裂尾部）。

## 错误码

| 码 | 含义 |
|---|---|
| `QUOTA` | 租户磁盘硬配额将被超出（append 拒绝该条，继续处理后续输入） |
| `CORRUPT` | 页校验失败 / 撕裂尾部 / 输入 JSON 非法 |
| `SEQ_GAP` | 租户内序号不连续（期望 `lastSeq+1`） |
| `READONLY` | 对只读日志（`--readonly` 打开或目录含 `READONLY` 标记文件）执行写操作 |

## 页格式与哈希链

定长页（默认 4096 字节，可配置），布局：

```
[0,8)    magic "AUDPG001"
[8,12)   pageIndex      uint32 LE
[12,16)  recordCount    uint32 LE
[16,20)  payloadLength  uint32 LE
[20,52)  prevHash       前一页的 pageHash（genesis = 32 字节全零）
[52,84)  payloadHash    sha256(payload)
[84,96)  保留（全零）
[96, 96+payloadLength)  payload：JSONL 记录
[pageSize-32, pageSize) trailer：pageHash = sha256(header[0,96) || payload)
```

`root` = 最后一页的 `pageHash`。篡改页内任何字节都会被 `payloadHash`、
`trailer` 或 `prevHash` 链之一捕获（`test/verify.test.js` 覆盖三种篡改点）。

## 提交点与故障模型

- **提交点 = fsync**：页先 `writeSync` 落盘，随后 `fsyncSync` 才算提交。
- **append 成功后、fsync 前崩溃**：该页视为未提交。恢复时校验失败（模拟为
  全零/撕裂页），日志截断到最近一致页，孤儿字节移入 `quarantine/` 并输出
  证明（`offset`、`length`、`sha256`、`reason`、最后已提交页与哈希）。
- **fsync 后崩溃**：该页必须重放可见——恢复扫描会原样接受全部已提交页。
- 崩溃注入：`AppendLog.open(dir, { onBeforeFsync })` 钩子 + `log.simulateCrash()`
  （把未 fsync 的尾部确定性置零，模拟丢失的未提交写）。
- **恢复是确定的**：索引重建到最近一致页即停；同一目录重复 `recover` 是幂等
  空操作且 `root` 不变（有测试断言）。

## 配额与公平调度

- 每租户令牌桶速率配额 `ratePerSec`（桶容量 = 1 秒的量，允许单次突发）。
- 磁盘硬配额 `diskBytes`：已提交 + 已缓冲字节数超出即拒绝（`QUOTA`），
  aging 与权重都不能绕过。
- 调度权重 = `baseWeight + 等待秒数 × agingFactor`（加法 aging；自上次被
  服务起计时）。因为 aging 项是加性的，任何等待中的租户最终都会超过权重
  固定的竞争者，饥饿有界：
  `starvationBoundMs(t) = (maxOtherWeight − baseWeight(t)) / agingFactor × 1000 + quantum`，
  测试断言队首等待不超过该界；对照实验（`agingFactor = 0`）证明低权重租户
  会被拖到竞争者排空。
- 缓冲页有限：`bufferPages` 决定内存中最多缓冲的负载字节数，超限自动 flush。

## 恢复与验证的确定性

`recoverLog` / `verifyLog` 共享同一扫描器：逐页校验 magic、页号、长度、
payload 哈希、trailer、链链接，首个失败页即恢复点。`verify` 只读不改盘；
`recover` 截断并隔离孤儿字节。`test/replay.test.js` 用独立实现的朴素重放器
（`src/naive.js`，不共享校验代码）对 n≤10 的随机工作负载（40 个种子）做
对照：root、页数、记录数、每租户计数与字节数完全一致。

## 配置（--config）

```json
{
  "pageSize": 4096,
  "bufferPages": 4,
  "agingFactor": 1,
  "quotas": {
    "tenant-a": { "ratePerSec": 100, "diskBytes": 1048576, "weight": 2 }
  }
}
```

未配置的租户默认无限制（权重 1）。

## 文件

- `src/page.js` — 页编码/校验、SHA-256 哈希链
- `src/scheduler.js` — 令牌桶 + 加法 aging 的加权公平调度器
- `src/log.js` — AppendLog（append/flush/崩溃模拟）、`recoverLog`、`verifyLog`
- `src/naive.js` — 朴素重放器（测试对照用）
- `src/cli.js` + `bin/auditlog.js` — CLI（`main(argv, io)` 可注入 io，便于进程内测试）
- `test/` — 29 个用例：恢复（fsync 前/后崩溃）、调度公平性与硬配额、篡改检测、
  朴素对照、CLI 端到端

## 已知限制（如实说明）

- 崩溃模拟是确定性的：未 fsync 区域按"全零撕裂"处理；真实崩溃也可能留下
  部分旧数据，但恢复逻辑对任何校验失败的页行为一致（截断 + 隔离）。
- 调度器使用虚拟时钟（每次派发前进一个 quantum，令牌不足时跳到下次补充），
  不模拟真实墙钟延迟。
- 日志整文件读入内存扫描，适合审计规模；未做增量索引持久化。
- 测试环境禁止嵌套 spawn，CLI 测试通过注入 io 在进程内完成；
  `bin/auditlog.js` 另经真实进程冒烟验证（append → verify root 一致）。
