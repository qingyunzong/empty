# stable-admissions

录取库：按双侧偏好列表与机构容量求稳定分配，支持嵌套分类配额、申请撤回重算、
无阻挡对证书，以及小实例上的穷举核对。TypeScript + Node.js 内置库，零 npm 依赖。

## 模型

- **申请人**：`id`、类别集合 `categories`（可同时属于多类）、偏好列表 `prefs`。
- **机构**：`id`、容量 `capacity`、嵌套分类配额树 `quotas`、偏好列表 `prefs`。
- **平局打破**：偏好列表中数组表示同级平局，一律按 ID 字典序固定打破，得到严格序。
- **可接受性**：未出现在对方偏好列表中的对视为不可接受，任何可行分配只含互相可接受的对。
- **嵌套配额**：配额为类别树；录取集合须满足容量及每个节点的类别上限
  （申请人属于某类别即计入该节点；多类申请人同时计入多个节点）。
- **规模上限**：至多 10 名申请人、6 所机构（`buildMarket` 校验，超限抛错）。

## 稳定性与明确替换规则

申请人对机构严格偏好于当前席位（或未分配且机构可接受），且机构可接受该申请人时，
若存在旧集合 `R ⊆ S`（`S` 为机构当前录取集）使得：

1. `S' = (S \ R) ∪ {a}` 满足容量与全部嵌套配额；且
2. 偏好改善：`R = ∅`（纯增员），或申请人在机构严格序上优于 `R` 中**每一个**成员；

则 `(a, i)` 构成阻挡对，`R` 为阻挡替换集。分配稳定当且仅当可行且不存在阻挡对。
`findBlockingPairs` 枚举每个阻挡对的**所有**合法替换集。

## 求解

- 无配额市场：申请人提议的延迟接受算法（`src/da.ts`），输出申请方最优稳定分配。
- 含嵌套配额市场：穷举所有可行分配（`src/enumerate.ts`，DFS + 配额剪枝），
  返回稳定分配及证书；若全部可行分配均有阻挡对，输出无稳定证明
  （每个可行分配附一个阻挡对+替换集见证）。
- 撤回：`withdrawApplicants(market, ids)` 移除申请人及其申请、并从机构偏好表中删除，
  返回新市场后可重新求解。
- 证书：`buildCertificate` 生成无阻挡对证书（逐机构可行性证据 + 每个潜在阻挡对的
  不可阻挡理由），`verifyCertificate` 独立重算校验。

## 使用

```bash
npm test                                        # 编译并运行全部测试
npm run solve -- examples/quota.json            # 求解实例并输出证书
node dist/src/cli.js examples/no-stable.json    # 输出无稳定证明
node dist/src/cli.js examples/simple.json --withdraw=a1   # 撤回后重算
```

实例格式见 `examples/*.json`。

## 实际运行结果（2026-10-06，Node v22.22.1，tsc 7.0.2）

`npm test` 输出：

```
ok 1 - dist/test/da.test.js
ok 2 - dist/test/model.test.js
ok 3 - dist/test/quota.test.js
ok 4 - dist/test/withdraw.test.js
# tests 4
# pass 4
# fail 0
```

共 21 个用例（model 6、da 4、quota 8、withdraw 3），全部通过，覆盖：

- 平局按 ID 打破、未列对不可接受、10/6 规模上限、输入校验；
- 延迟接受与穷举在 60 个随机小实例上交叉核对（DA 结果必在枚举稳定集内）；
- 嵌套配额生效、多类申请人多节点计数、拒绝整个旧集合的替换集；
- 无稳定实例（`examples/no-stable.json`）：11 个可行分配全部存在阻挡对，输出证明；
- 撤回后重算、证书防篡改校验。

CLI 实测：

- `examples/simple.json` → 稳定分配 `{a1:i1, a2:i2, a3:i3}`（deferred-acceptance），证书校验通过；
- `examples/quota.json` → 17 个可行分配中唯一稳定分配 `{a1:i1, a2:i2, a3:i1}`，证书校验通过；
- `examples/no-stable.json` → `no-stable-exists`，11 个可行分配各附阻挡对见证；
- `examples/simple.json --withdraw=a1` → 重算得 `{a2:i2, a3:i1}`，证书校验通过。

## 目录结构

- `src/model.ts` — 类型、校验、平局打破、配额可行性
- `src/stability.ts` — 阻挡对与替换集枚举
- `src/certificate.ts` — 无阻挡对证书生成与独立校验
- `src/enumerate.ts` — 全部分配穷举与稳定分类
- `src/da.ts` — 延迟接受算法（无配额市场）
- `src/solver.ts` — 求解入口、无稳定证明、撤回
- `src/cli.ts` — 命令行入口
- `scripts/find-no-stable.ts` — 随机搜索无稳定实例的工具
- `test/` — node:test 测试（确定性种子随机实例）
