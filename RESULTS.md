# RESULTS — 可审计聚合 CLI

环境：Node.js v22.22.1，仅用标准库（`crypto` / `fs` / `path` / `node:test` / `child_process`）。

## 测试总览

`node --test` 真实退出码：**0**（全部通过）

```
✔ test/audit.test.js
ℹ tests 1   (7 个子测试全部 ok)
ℹ pass 1
ℹ fail 0
```

子测试明细（`node test/audit.test.js` TAP 输出，全部 ok）：

| # | 验收点 | 结果 |
|---|--------|------|
| 1 | A：更正前后 as-of 查询结果不同 | ok |
| 2 | B：篡改未参与聚合的行（被取代行 / 无效行）证书失败 | ok |
| 3 | C：1000 行增量构建与全量重建 result/proof 完全一致 | ok |
| 4 | D：全 NULL 金额 + 空类别边界 | ok |
| 5 | E_FUTURE_CORRECTION：更正指向未来/未知 id | ok |
| 6 | 输入已变但证书未重新生成（过期证书）被拒绝 | ok |
| 7 | 篡改 result.json 被拒绝 | ok |

## 真实退出码（手动复现，命令均实际执行）

退出码约定：`0` 成功；`2` = E_FUTURE_CORRECTION；`3` = E_PROOF；`1` = 用法/解析错误。

| 场景 | 命令 | 退出码 | 输出 |
|------|------|--------|------|
| 全量构建 | `node audit.js build --in entries.jsonl --out out` | 0 | `build ok (full): 2 categories, root=f05f11b3…` |
| as-of 构建 | `node audit.js build --in entries.jsonl --out out2 --asof 2` | 0 | food: sum=100（全量为 150，验收 A） |
| 验证通过 | `node audit.js verify out out/proof.json` | 0 | `verify ok: root=f05f11b3…` |
| 篡改未用行（验收 B） | 改 snapshot 中被取代行金额后 `verify` | 3 | `E_PROOF: proof mismatch: inputHash, leaves` |
| 过期证书 | 追加更正对 snapshot、保留旧 proof 后 `verify` | 3 | `E_PROOF: proof mismatch: inputHash, leaves, categories, root, result.json` |
| 未来更正 | `build` 指向未知 id `x9` 的输入 | 2 | `E_FUTURE_CORRECTION: row 1 (x1) corrects unknown or future id "x9"` |

## 失败用例（证书必须拒绝的情形，均已验证 exit != 0）

- **篡改被取代行**：superseded 行不参与聚合，但其叶哈希进入证书 → `E_PROOF`，exit 3。
- **篡改无效行**（`valid:false`）：同上 → `E_PROOF`，exit 3。
- **过期证书**：输入演进（新增更正）后未重新生成 proof → inputHash 不匹配 → `E_PROOF`，exit 3。增量构建本身会重新生成完整证书（含新 inputHash 与全部叶哈希），因此合法增量输出仍可通过 verify。
- **篡改 result.json**：与 proof 重算结果不一致 → `E_PROOF`，exit 3。
- **未来更正**：`corrects` 指向序列中尚未出现/不存在的 id → `E_FUTURE_CORRECTION`，exit 2。

## 设计要点

- **数据模型**：每行 `{id, account, amount, category, valid, corrects}`；`corrects` 指向先前行 id 即取代之。被取代行与 `valid:false` 行不进聚合，但作为叶进入证书。
- **as-of**：`--asof N` 仅取前 N 行（按文件顺序的 seq）重放，更正事件自然改变后续 as-of 视图。
- **证书（proof.json）**：规范化关系代数表达式
  `project[category,sum,count](group_by[category; sum=sum(amount), count=count(*)](select[valid=true and supersededBy=null](entries)))`、
  输入整体 SHA-256、每叶行哈希（含 included/supersededBy）、每类别聚合路径（叶哈希列表 + 类别摘要）与根哈希。
- **verify**：从 `out/input.snapshot.jsonl` 独立重算全部哈希与聚合，逐项比对 inputHash / expression / leaves / categories / root / result.json，任一不符即 `E_PROOF`。
- **增量**：`build --incremental --prev <dir>` 对比前次快照，仅重算受影响类别（新增/变更/被删行及其更正目标的类别），其余类别复用前次证书摘要；输出仍是完整证书，verify 语义不变。
- **边界**：`amount:null` 按 0 计入 sum、计入 count；`category:null` 归一化为 `""` 分组。

## 复现

```
node --test                 # 全部测试，exit 0
node audit.js build --in entries.jsonl --out out
node audit.js verify out out/proof.json
```
