# boiler-interlock-log

离线合并锅炉房三台采集器的联锁 / 旁路 / 复位日志，判定当前阀门态。
Node.js 22，仅标准库，测试用 `node:test`，单进程模拟多副本，无网络依赖。

## 事件格式（JSONL，每行一个事件）

```json
{"id":"a:2","member":"a","epoch":1,"seq":2,"kind":"interlock","valve":"V1","clock":{"a":2},"ts":1730000000}
```

- `kind`: `join` / `leave`（成员代次管理），`interlock` / `bypass` / `unbypass` / `reset`（数据事件，需 `valve`）。
- `clock`: 向量时钟，`clock[member]` 必须等于 `seq`。
- `epoch`: 成员代次（fencing token），join 从 1 开始连续递增。
- `ts`: 仅信息性字段，**绝不**参与排序或冲裁，禁止时间戳平票随机。

## 确定性规则

终态是事件**集合**的纯函数，与到达顺序、文件顺序、重复投递无关：

- **因果序**：按向量时钟拓扑排序；并发事件按 `(epoch, id)` 升序，后应用者胜出。
- **墓碑仲裁**：`unbypass` 即墓碑。同刻（并发）的墓碑与复活按 成员代次 → 因果 → id 确定；
  有因果先后时因果优先（同刻规则不适用）。
- **fencing 代次**：数据事件 `(m, e)` 被拒绝当且仅当：
  - `(m, e)` 无对应 join（`epoch-not-joined`）；
  - 更高代次 join 在其因果过去中（`fenced-by-higher-epoch`，高代次拒绝低代次写入）；
  - 同代次或更高代次 leave 在其因果过去中（`fenced-after-leave`）。
  leave 之前/并发的旧事件仍参与历史。
- **未知成员**：任何非 join 事件的成员在日志中无 join → 硬错误，exit 4。

## 反熵与收敛证明

`Replica.digest()` 交换摘要（canonical-order 的 sha256 + 向量时钟 + 每成员 seq 区间）；
`offerTo(remoteDigest)` 只给出对方缺失的事件；`syncReplicas(a, b)` 一轮后比较摘要，
hash 相等即收敛，返回证书 `{converged, hash, count, clock}`。

## CLI

```sh
node bin/boiler.js merge  a.jsonl b.jsonl c.jsonl   # 终态 + 成员 + 拒绝列表 + 证书
node bin/boiler.js status a.jsonl                   # 各阀门态 + 成员代次 + 证书
node bin/boiler.js digest a.jsonl                   # 打印摘要
node bin/boiler.js digest a.jsonl b.jsonl           # 比较摘要
```

退出码：`0` 正常；`2` 用法/输入非法；`4` 未知成员新事件；`5` 摘要不一致（stdout 给出逐成员分歧区间）。

## 测试

```sh
node --test        # 全量；真实结果见 test-results.txt
```

验收覆盖：三副本乱序终态 == 全量重放；墓碑/复活同刻边界确定；leave 后高代次拒绝低代次写入；
≤8 事件全部排列（8! = 40320）对照库结果；反熵只拉缺失且收敛可证。
