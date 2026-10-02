# satsched — 卫星地面站科学数据下行排程

Node.js 22，仅标准库与 `node:test`，无任何第三方依赖。

## 模型

- 时间一律为整数秒；单天线同一秒只能服务一个过顶。
- 每个过顶（pass）：`id / task / start / end / elevation / rate / priority / onboard`（星上剩余字节）。
- 任务（task）随 pass 登记，可带 `--quota`（日配额）与 `--min-guarantee`（最小保障）。
- 全局配置（首次写入时固定）：`--setup` 切换建立秒（默认 10）、`--lock` 段锁定秒（默认 30）、`--max-rate` 链路速率上限（默认 1000000）。

## 命令

```
node src/cli.js [--dir DIR] <cmd> ...

pass      --id P --task T --start S --end E --elevation D --rate R --onboard B
          [--priority N] [--quota Q] [--min-guarantee G]
schedule  [--seconds]            # 秒级时间线（默认合并段输出）+ 任务总量 + 哈希链证书
correct   --pass P --start S --end E [--at T] [--pending]   # 气象更正，交集收缩可用窗
correct   --pass P --confirm     # 确认未决气象：pending 转为 weather
drop                             # 丢包责任：weather / conflict / quota / pending（未决不判失败）
undo      [--steps N] [--to-pass P]   # 多层撤销到任意 pass 边界
verify    [--recover]            # 校验哈希链证书；--recover 截断到最长有效前缀
```

## 核心语义

- **重叠选择**：亏欠（`minGuarantee − 已下行`）大者优先；同亏欠并列按任务 ID、再按开始秒、再按 pass ID。切换需 `setup` 秒（首段空闲预指向豁免）。
- **抢占**：仅在段开始 `lock` 秒后（未锁定）且候选亏欠严格更优时发生；已传字节保留，被抢占过顶可后续续传。
- **更正**：可用窗与更正窗求交；缩短只影响与之相交的任务；`--pending` 的未决气象计入 `pending`，不计入失败。
- **确认字节**：`correct --at T` 把 T 之前已排下行段固化为已确认；撤销含已确认字节的条目被拒绝（exit 9）。
- **undo**：`--steps N` 弹 N 层；`--to-pass P` 撤销到该 pass 最近变更之前。undo 以追加条目记录，重放确定。
- **哈希链证书**：journal 每条含 `prev/state/hash`（sha256，规范 JSON）。`verify` 重放全部前缀校验；写入故障（半截行）被拒绝并可用 `--recover` 恢复。

## 退出码

- `0` 成功；`2` 用法错误；`8` 证书校验失败；`9` 领域错误（负仰角 / 速率超链路 / 撤销已确认字节）。

## 测试

```
node --test test/*.test.js
```

验收对照：`test/scheduler.test.js` 用子集 DP 枚举（`src/oracle.js`，n≤12）对照最大有效字节；`test/correct.test.js` 验证更正只影响相交任务；`test/fairness.test.js` 验证同亏欠并列按任务 ID 与开始秒；`test/journal.test.js` / `test/cli.test.js` 验证哈希链拒半截并恢复、undo 与 exit 9。
