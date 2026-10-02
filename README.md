# budget_gate — 多层日历预算闸门

按**业务日**与**滚动窗口**共同限制的预约额度库，纯 Python 3.11 标准库实现
（`zoneinfo` / `threading` / `json`），无任何第三方依赖。

## 模型

- **主体层级（DAG）**：`add_subject(name, parents)`。预留按主体发起，消耗其
  自身及全部祖先节点上的配额规则；同一父配额经多条继承路径只计费一次
  （按 `rule_id` 去重）。
- **配额规则**：`set_quota(subject, rule_id, windows)`，一条规则可含多个窗口，
  预留须在**所有**窗口同时放得下才成立（检查全部通过后才统一提交，任一窗口
  失败则完整回滚，不留部分占用）。
- **窗口类型**：
  - `business_day`：按命名 IANA 时区的**本地日界**分桶。日界由时区表换算为
    真实 UTC 时刻，夏令时日的长度是 23/25 小时，绝不以固定 86400 秒替代。
  - `calendar`：本地 ISO 周 / 自然月窗口。
  - `rolling`：以**真实时间点**计算的滑动持续时长窗；在执行时刻 `t` 校验
    半开区间 `(t - seconds, t]` 内的占用。跨时区的预留共享同一真实时间轴，
    不会各自通过却合计超额。
- **请求**：幂等 `id`、`amount`（预留量）、`confirm_by`（确认期限）、
  `execute_at`（执行时间）、`now`（操作发生时刻，显式传入以便审计与重放）。

## 线性化顺序

所有变更操作（reserve / confirm / cancel / expire / tick / set_quota）各自
构成单一临界区，由同一把可重入锁串行化；获得锁的顺序即线性化顺序。
`tick` 按 `(confirm_by, id)` 的确定顺序触发到期。配额下调在该线性化点
生效：存量预留被豁免（继续占用），新预留必须满足新额度。

## 幂等与版本化计时器

- 相同 `id` + 相同负载的重放返回**首次记录的结果**（含拒绝），不重复计费；
  相同 `id` + 不同负载且原预留仍活跃 → `id_conflict`。
- 预留进入终态（expired/cancelled）后，`id` 可被新请求复用，版本号递增。
  confirm/cancel/expire 均携带版本：迟到的取消或过期计时器命中旧版本时
  返回 `stale_version`，**不会**释放后续同 id 新请求的额度。
- 崩溃恢复：CLI 在响应前原子落盘（tmp + rename + fsync）。若崩溃发生在
  确认写入与响应之间，客户端重试即幂等重放，返回已记录的结果。
  设 `BUDGET_GATE_CRASH_AFTER_WRITE=1` 可模拟该崩溃点（退出码 75）。

## 拒绝证据

拒绝结果列出每一个失败窗口的完整证据：`rule_id`、配额所属主体、窗口描述、
分桶键、容量、当前占用、请求量、可用量。

## CLI

```sh
python3.11 -m budget_gate.cli --state state.json '{"op":"add_subject","subject":"s1"}'
python3.11 -m budget_gate.cli --state state.json '{"op":"set_quota","subject":"s1","rule_id":"r1",
  "windows":[{"type":"business_day","tz":"Asia/Shanghai","capacity":10},
             {"type":"rolling","seconds":3600,"capacity":5}]}'
python3.11 -m budget_gate.cli --state state.json '{"op":"reserve","id":"q1","subject":"s1",
  "amount":3,"execute_at":1696118400,"confirm_by":1696120000,"now":1696118400}'
python3.11 -m budget_gate.cli --state state.json '{"op":"confirm","id":"q1","version":1,"now":1696118401}'
```

操作：`add_subject` / `set_quota` / `reserve` / `confirm` / `cancel` /
`expire` / `tick` / `occupancy` / `status`。操作 JSON 也可从 stdin 读入。
输出 `{"ok": true, "result": ...}` 或 `{"ok": false, "error": ...}`；
业务性拒绝属于 `ok: true` 且 `result.status == "rejected"`。

## 库用法

```python
from budget_gate import BudgetGate, WindowSpec

g = BudgetGate()
g.add_subject("hq")
g.add_subject("team", ["hq"])
g.set_quota("hq", "r1", [WindowSpec(kind="rolling", capacity=5, seconds=3600)])
g.reserve(id="q1", subject="team", amount=3,
          execute_at=1696118400, confirm_by=1696120000, now=1696118400)
g.confirm(id="q1", version=1, now=1696118401)
```

## 测试

```sh
python3.11 -m unittest discover -s tests -v
```

56 个测试覆盖：DST 折叠时间与 23/25 小时日长、跨午夜预留、跨时区共享滚动
窗口、最后额度争用、部分窗口失败完整回滚、菱形继承去重、配额下调/上调、
版本化计时器与迟到取消、幂等重放、崩溃在确认写入与响应之间（CLI 退出码 75
后重放）、以及小时间域少量请求下**枚举全部合法串行历史核对并发交错**
（线性化一致性）。最近一次运行记录见 `TEST_RESULTS.txt`（56 tests, OK）。
