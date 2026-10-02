# mes-interlock

注塑车间 MES 安全联锁策略解释器：把 Excel 里的联锁策略迁移为可执行、可复核的判定引擎。
Node.js 22，仅标准库，单机离线。

## 使用

```bash
node bin/mes-interlock.js \
  --policies policies.json \
  --requests requests.jsonl \
  --decisions decisions.jsonl \
  --audit audit.log
```

示例数据见 `examples/`，可直接运行：

```bash
node bin/mes-interlock.js -p examples/policies.json -r examples/requests.jsonl \
  -d decisions.jsonl -a audit.log
```

退出码：`0` 成功；`2` JSON 非法/配置或请求格式错误；`3` 未知主体/设备（含悬空引用）；`4` 角色或区域继承环（stderr 列出环路径）。

## 策略模型（policies.json）

- `roles` / `zones`：节点可含 `inherits: [...]`，构成角色链与区域链（多继承取最小深度）。
- `subjects`：`{ name: { roles: [...] } }`；`devices`：`{ name: { zone } }`。
- `rules`：每条规则含
  - `id`、`effect`（`allow`/`deny`）、`action`（如 `openMold`/`heatUp`/`resetEstop`/`emergencyStop`，`*` 通配）；
  - 可选 `role`、`zone`：规则挂载在角色链/区域链的某一级，沿双链继承生效；
  - 可选 `window`：每日时间窗 `{"start":"08:00","end":"18:00"}`（支持跨零点）或绝对 ISO 区间（含头不含尾）；
  - 可选 `revokeAt`：撤销生效点。普通规则只影响生效点及之后的请求；`action: "emergencyStop"`（或 `emergency: true`）的规则撤销是**回溯性**的——一旦撤销，依赖它的历史授权全部失效。

## 判定语义

1. 规则与请求匹配：动作（精确优先于 `*`）、角色深度、区域深度、时间窗、撤销状态。
2. 距离 = `(roleDepth + zoneDepth) * 2 + (action === '*' ? 1 : 0)`，未约束的维度计为大数；**距离最小（最近具体）的规则优先**。
3. 同级同时存在 allow 与 deny → 默认 **deny**，并在决定中生成冲突证书（`conflict` 字段，含双方规则 id 与 resolution）。
4. 无任何适用规则 → 默认 deny（`no-applicable-rule`）。
5. 紧急停机规则被撤销后，若历史请求本应依赖它获得 allow，则重放判定为 deny，原因 `retroactive-revocation`，并列出 `retroactiveRevocations`。

## 决定记录（decisions.jsonl 每行）

- `decision` / `reason`：结论与原因。
- `rulePath`：全部适用规则按距离排序，标注 winner/overridden 及各链深度。
- `winners` / `overridden`：生效规则与被覆盖规则（含覆盖原因：`less-specific`、`conflict-deny-default`、`retroactive-revoked`）。
- `conflict`：同级 allow/deny 冲突证书（无冲突为 `null`）。
- `counterexample`：使结论翻转的最小改动（单字段请求变更或单组规则增删），引擎已重放验证（`verifies: true`）。`verifyRecord()` 可独立复核任意决定记录及其反例，检出“应拒绝却允许”的伪造记录。

`audit.log` 为每请求一行的人类可读审计日志，含决定、原因、生效/被覆盖规则、冲突与反例摘要。

## 测试

```bash
node --test
```

- `test/acceptance-a.test.js`：继承+冲突混合 50 请求，逐条与参照实现对照并校验证据字段。
- `test/acceptance-b.test.js`：撤销后重放历史，普通撤销前后一致、紧急停机撤销回溯生效。
- `test/acceptance-c.test.js`：伪造“应拒绝却允许”的决定可被 `verifyRecord` 检出；反例可重放翻转。
- `test/acceptance-d.test.js`：n≤8 条规则枚举全部 2^n 种 allow/deny 赋值（共 1530 组）与独立参照实现 `src/reference.js` 对照。
- `test/cli.test.js`：CLI 端到端与退出码 2/3/4。
