# RESULTS — 可审计聚合 CLI 验收结果

环境：Node.js v22.22.1，仅标准库（`node:crypto` / `node:fs` / `node:path` / `node:child_process`），
测试框架 `node:test`，命令 `node --test`。

## 测试运行（真实退出码）

```
$ node --test
# tests 1 (文件 test/audit.test.js，含 9 个子测试)
# pass 1
# fail 0
退出码: 0
```

子测试明细（全部通过）：

| # | 用例 | 结果 |
|---|------|------|
| 1 | A: as-of query before and after a correction differs | ok |
| 2 | B: modifying a superseded (unused) row fails verification with E_PROOF | ok |
| 3 | B2: tampering with the output file fails verification | ok |
| 4 | C: incremental correction recomputes only affected categories, matches full rebuild | ok |
| 5 | D: all NULL/empty categories aggregate under "(null)"; empty input works | ok |
| 6 | E_FUTURE_CORRECTION: forward reference and unknown target exit non-zero | ok |
| 7 | invalid rows are excluded from aggregation but committed to the proof | ok |
| 8 | duplicate ids are rejected | ok |
| 9 | correction chains: only the final correction stays active | ok |

失败用例：无（0 failures）。

## 验收标准对照

- **A 更正前后 as-of 不同**：`--as-of 3` 时 food={sum:150,count:2}（e1 未被取代）；
  全量（含第 4 行更正 c1→e1）后 food={sum:200,count:2}，rootHash 不同。被取代行
  状态为 `superseded`，不进聚合但保留在 proof.leaves 中。
- **B 改一条未用行证书失败**：篡改被取代行 amount（100→101）后
  `audit verify` 退出码 **3**，stderr：
  `E_PROOF: inputHash mismatch (input changed after proof was built: stale proof); leaf hashes/statuses mismatch (an input row was modified)`。
  篡改输出文件同样退出码 3（outputHash mismatch）。
- **C 增量与全量 1000 行对照**：1000 行 + 追加 10 条更正；`--incremental` 只重算
  受影响类别（proof.meta.incremental.affectedCategories ≤ 4 个，其余 6+ 类别复用），
  增量输出与全量重算**逐字节一致**，rootHash 相同。旧证书（更正前）verify 被拒绝：
  退出码 3，`E_PROOF: inputHash mismatch ... stale proof`。
- **D 全 NULL/空类别边界**：category 为 null/""/缺失统一归入 `(null)` 组
  （sum=35,count=3，valid=false 行被排除）；空输入文件产出空 categories、asOf=0，
  verify 通过。

## 错误码与退出码（实测）

| 错误 | 退出码 | 触发 |
|------|--------|------|
| `E_FUTURE_CORRECTION` | 2 | 更正指向未知 id 或尚未出现的行（前向引用） |
| `E_PROOF` | 3 | verify 重算不一致：输入哈希/叶哈希/聚合路径/rootHash/outputHash 不匹配，含过期证书 |
| `E_DUPLICATE_ID` | 4 | 重复 id |
| `E_PARSE` | 5 | 非法 JSON 行 / 非法参数 |
| 其他 | 1 | 用法错误等 |

## 设计要点

- **数据模型**：每行 `{id, account, amount, category, valid, corrects}`；行号即序列号（as-of 游标）。
- **取代语义**：仅 `valid` 的更正行使目标行 superseded；支持更正链，只有最终更正行 active；
  被取代/无效行不进聚合，但作为叶（含 sha256 行哈希与状态）进入证书。
- **证书（proof.json）**：规范化关系代数表达式
  `pi[category,sum,count](group_by[category; sum:=sum(amount); count:=count(*)](select[valid AND NOT superseded](entries[1..N])))`、
  全文件 inputHash（sha256）、每叶行哈希与状态、每类别聚合路径
  （pathHash = H(category,sum,count,有序叶哈希)）、rootHash、outputHash。
  verify 独立重算全部字段，任一不符即 E_PROOF。
- **增量**：`build --incremental [--prev-proof p0]` 先校验前缀叶哈希，只对
  “新增行类别 ∪ 状态变化行类别”重算聚合，其余类别复用；历史前缀被改写时回退全量。
  因 inputHash 提交整个输入文件，追加更正后旧证书必然被 verify 拒绝。
- **金额**：以分为单位整数累加（`Math.round(amount*100)`），避免浮点漂移；输出 `sum = cents/100`。
- **已知环境限制**：本沙箱中 node 孙进程的 stdio 管道会被丢弃，测试通过
  `/bin/sh -c '... >out 2>err; echo $?'` 包装捕获退出码与 stderr（见 test/audit.test.js 的 run()）。
