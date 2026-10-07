# budgetgate — 多层日历预算闸门

纯 Python 3.11 标准库实现（`zoneinfo` / `threading` / `json`），提供可嵌入库
`budgetgate` 与 JSON-lines CLI `budgetgate.cli`。

## 模型

- **主体层级**：配额节点构成 DAG。预留沿主体到所有祖先收费，按节点 id 去重——
  同一父配额经多条继承路径（菱形）只计一次。
- **窗口**（每个节点可挂多条规则）：
  - 日历窗 `hour|day|week|month`：按**时区表**中命名时区的本地日界分桶；
    业务日即本地日期。日界由 `zoneinfo` 本地化午夜求得，DST 日为 23/25 小时，
    绝不使用固定 86400 秒。
  - 滚动窗 `rolling`：以真实时间点计算的尾随时长窗。准入检查新条目时点及
    其前向跨度内所有既有条目时点，乱序执行时间无法绕过容量。
- **请求**：幂等 id、预留量、确认期限、执行时间（额度归属时点）。

## 线性化顺序

所有变更操作（预留/确认/取消/超时/配额更新）在单锁下：先处理 `now` 时刻到期的
**带版本**超时事件，再向事件日志追加一条带序号的事件并改状态。日志序号即
线性化序。预留在所有相关窗口上原子生效：任一窗口失败即整体拒绝（附具体窗口、
容量、当前占用与占用者证据），应用阶段异常则完整回滚。

## 幂等与版本

- 活跃中的同 id 同负载重放返回首次结果；不同负载报 `IdempotencyConflict`。
- 终态（取消/过期）后同 id 复用获得递增版本。
- 确认/取消可携带目标版本：迟到取消命中旧版本时为 no-op，**不会**释放后续
  同 id 新请求的额度；超时事件同样只杀死其调度的 `(id, version)`。
- `snapshot()`/`restore()` 支持崩溃恢复：崩溃发生在确认写入与响应之间时，
  重放同一确认幂等返回已确认。

## CLI

```sh
python3.11 -m budgetgate.cli state.json << 'CMDS'
{"op": "configure", "timezones": {"home": "Asia/Shanghai"},
 "nodes": {"root": {"windows": [{"id": "bd", "kind": "day", "tz": "home", "capacity": 100}]},
           "svc": {"parents": ["root"]}}}
{"op": "reserve", "request_id": "r1", "subject": "svc", "amount": 10,
 "execute_at": "2026-01-01T16:00:00+00:00",
 "confirm_deadline": "2026-01-01T17:00:00+00:00", "now": "2026-01-01T15:00:00+00:00"}
{"op": "confirm", "request_id": "r1", "now": "2026-01-01T16:30:00+00:00"}
{"op": "status"}
CMDS
```

每行一个 JSON 命令，stdout 每行一个 JSON 结果；状态在每个命令后持久化到
`state.json`。其他操作：`cancel`、`expire`（运行到期计时器）、
`set_capacity`。

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

覆盖：DST 折叠时间与 23/25 小时日界、跨午夜预留、滚动窗真实时点与乱序执行、
菱形层级去重、最后额度争用、部分窗口失败完整回滚、配额降低、崩溃在确认写入
与响应之间及重放幂等、迟到取消不释放新版本额度；并以小时间域 + 两条请求
枚举全部合法串行历史（含逐历史不变量检查），再用并发交错执行核对结果必落在
某个已枚举的串行历史之内。
