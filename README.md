# archive-restore

科学归档恢复调度系统。Node.js 22，仅用标准库与 `node:test`。

## 模型

- 对象：`id, size, checksum, retention(保留级), requester, parent(依赖父卷), locked, quota`
- 双资源：带宽（每 tick 字节数）+ 暂存盘容量（字节）
- 证据：每次恢复/驱逐/更正写入哈希链证书，恢复后可独立 `verify`

## CLI

```
node cli.js request --dir D --id a --size 10 --retention 5 --requester r1 [--quota 1] [--parent p] [--locked] [--checksum H] [--data S]
node cli.js restore --dir D [--capacity N] [--bandwidth N] [--wait-cap N] [--fail-at staging|index|cert]
node cli.js correct --dir D --id a --checksum H
node cli.js evict  --dir D --id a
node cli.js verify --dir D
node cli.js undo   --dir D [--generations N]
```

`restore` 输出放置（offset/size）、带宽时间片、失败原因、证书链。状态持久化在 `D/state.json`。

退出码：校验和错 / 盘满 / 环依赖 → **11**；其他错误 → 1；成功 → 0。

## 核心语义

- **调度**：对可恢复对象（父卷已暂存或无父卷）做保留级加权的 0/1 背包（精确 DP），容量 = 总容量 − 不可驱逐占用。
- **抢占**：暂存不足时，按保留级升序驱逐未锁定且保留级低于当前最高待恢复级的对象，逐一生成 `evict` 证书（驱逐证明）；锁定对象永不驱逐。
- **配额公平**：时间片按请求方“完成字节亏欠”（应得份额 − 已完成字节）分配；等待 tick 数达到 `--wait-cap` 的对象优先，防止饿死。
- **更正**：`correct` 更新校验和后，该对象及全部依赖子卷标记为重验；无关卷不重验（`verifyCount` 不变）。未决父卷不判子卷不可恢复，子卷保持 pending。
- **undo**：所有变更操作按事务代际记录快照，`undo N` 回滚 N 代；故障注入点为三处写路径——写暂存、写索引、写证书，注入后整代回滚，`verify` 结果确定。

## 测试

```
node --test test/*.test.js
```

实测结果（2026-10-08, Node v22.22.1）：5 个测试文件全部通过（pass 5 / fail 0），覆盖四条验收：

1. `test/schedule.test.js` — n≤9 随机用例与 2ⁿ 枚举对照最大保留级加权恢复值（270 组全等）。
2. `test/preempt.test.js` — 暂存满时高保留级抢占低保留级、生成驱逐证明、`undo` 可撤销。
3. `test/correct.test.js` — 父卷更正只重验受影响子卷（含递归孙卷），无关卷 `verifyCount` 不变。
4. `test/fault.test.js` — staging/index/cert 三处故障注入后 `verify` 输出与注入前深度相等。
