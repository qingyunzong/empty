# boiler-interlock-merge

锅炉房联锁 / 旁路 / 复位事件的多副本离线合并库与 CLI。Node.js 22，仅标准库，`node:test` 测试，单机离线运行。

## 事件模型（JSONL，每行一个事件）

```json
{"id":"b2","member":"beta","epoch":1,"seq":2,"type":"bypass","key":"fw-1","clock":{"alpha":2,"beta":2}}
```

- `type`: `join` / `leave` / `interlock` / `reset` / `bypass` / `unbypass`
- `clock`: 向量时钟（成员 -> 序号），用于因果定序；**不使用墙钟时间戳**
- `epoch`: 成员代次（fencing token），每次 `join` 递增
- `bypass` / `unbypass` 需要 `key`（被旁路的联锁点）

## 规则

- **因果定序**：按向量时钟 happens-before 做拓扑排序，并发事件按 `(epoch, member, seq, id)` 字典序决胜，全序确定，与输入顺序无关。
- **成员 fencing**：`join` 使代次 +1，`leave` 后成员离线。数据事件仅当 `成员在席 && event.epoch === 当前代次` 才生效，否则记入 `rejected`（`reason: "fenced"`）；旧事件保留在历史中。未知成员的新事件抛 `UnknownMemberError`（CLI exit 4）。
- **墓碑**：`unbypass` 为 key 立墓碑。同刻（并发）墓碑与复活按 **成员代次 → 因果 → id** 仲裁：先比 epoch（高者胜），再比因果支配（后者胜），最后比 id（字典序大者胜）。无时间戳、无随机。
- **阀门态**：`interlocked=false` → `OPEN`；`interlocked=true` 且有存活旁路 → `BYPASSED`；否则 `CLOSED`。

## 反熵

- `computeDigest(events)` → `{members: {m: {maxSeq, maxEpoch}}, count, hash}`（hash 为排序后事件 id 的 sha256）。
- `missingRanges(localEvents, remoteDigest)` → 本地缺失的 `{member: [[lo,hi], ...]}` 区间，只拉缺失。
- `proveConvergence(...digests)` → 摘要全等即收敛证明。
- `divergence(a, b)` → 逐成员分歧区间 `[lo, hi]`（CLI digest 双文件不一致时输出，exit 5）。

## CLI

```sh
node src/cli.js merge  c1.jsonl c2.jsonl c3.jsonl   # 合并，输出终态 + 证书（digest/stateHash/orderHash）
node src/cli.js status c1.jsonl                     # 当前阀门态
node src/cli.js digest c1.jsonl                     # 单个摘要
node src/cli.js digest c1.jsonl c2.jsonl            # 比较；不一致 exit 5 并输出分歧区间
```

退出码：`0` 正常；`1` 输入/校验错误；`2` 用法错误；`4` 未知成员新事件；`5` 摘要不一致。

## 库 API

```js
import { mergeEvents, replay, canonicalOrder, resolveWinner } from './src/store.js';
import { computeDigest, missingRanges, proveConvergence, divergence, certificate } from './src/digest.js';
import { runCli } from './src/app.js';
```

## 测试

```sh
node --test        # 全量
```

覆盖验收项：三副本乱序合并 == 全量重放；墓碑/复活同刻确定性；离开后高代次拒绝低代次写入；≤8 事件全排列（1!+2!+…+8! = 46233 种）终态一致；反熵只拉缺失并证明收敛；CLI exit 4/5。
