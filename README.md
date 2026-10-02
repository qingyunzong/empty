# MES 安全联锁策略解释器

注塑车间 MES 的“安全联锁策略”可执行解释器：读取声明式策略与操作员请求
（开模 `open_mold`、升温 `heat_up`、复位急停 `reset_estop`），对每条请求判定
allow/deny 并输出可复核证据。Node.js 22，仅标准库，单机离线。

## 用法

```sh
node src/cli.js --policies policies.json --requests requests.jsonl \
                --decisions decisions.jsonl --audit audit.log
node --test        # 运行全部测试
```

退出码：`0` 成功；`1` IO/用法错误；`2` JSON 非法或输入不合法；
`3` 未知主体/设备；`4` 继承环（stderr 列出环，如 `a -> b -> c -> a`）。

## 策略模型（policies.json）

- `roles` / `zones`：继承图，`{"operator": {"inherits": ["worker"]}}`，支持多父继承。
- `subjects`：主体及其直接角色；`devices`：设备及其所属区域。
- `rules`：规则数组，字段：
  - `id` / `action` / `effect`（`allow`|`deny`）必填；
  - `role` / `zone` 可选，缺省为通配；
  - `window` 可选 `{start, end}`（ISO 8601，两端含）；
  - `revokeAt` 可选撤销时刻；`retroactive: true` 表示紧急停机类撤销可回溯。

## 核心语义

1. **双链继承合并**：主体角色沿角色链、设备区域沿区域链分别按最短距离展开；
   规则特异度 = （通配符数， 距离和），字典序最小者优先（最近具体规则优先）。
2. **同级冲突默认 deny**：同一特异度上 allow 与 deny 并存时判定 deny，
   并在决定与 audit.log 中生成冲突证书（`conflict` 字段 / `WARN` 行）。
3. **撤销**：`revokeAt` 仅影响该时刻及之后的请求；`retroactive` 的紧急停机
   撤销可回溯，使撤销点之前依赖它的授权一并失效，规则 id 记入
   `retroactivelyRevoked`。
4. **无匹配规则默认 deny**（联锁安全缺省）。

## 证据（decisions.jsonl 每条记录）

- `rulePath`：决定性规则及其角色/区域继承路径与特异度；
- `overridden`：被更高特异度覆盖的规则；
- `conflict`：冲突证书（同级冲突时）；
- `retroactivelyRevoked` / `alerts`：回溯撤销证据；当 allow 依赖于被回溯撤销的
  deny 时产生 `allow_depends_on_retroactively_revoked_deny:<ruleId>` 告警
  （audit.log 同步输出 `ALERT` 行）；
- `counterexample`：使结论翻转的最小改动（变更数、变异、翻转后结论），
  生成时已实际重放验证；库函数 `verifyCounterexample` / `verifyDecision`
  可供审计复核。

## 目录

- `src/model.js` 策略加载、校验、继承图、环检测
- `src/evaluate.js` 判定语义与审计行
- `src/counterexample.js` 反例生成与复核
- `src/cli.js` 命令行入口
- `fixtures/` 验收 A 的策略与 50 条请求（`scripts/gen-fixtures.js` 重新生成）
- `test/` node:test 测试（单元、错误码、验收 A–D）
