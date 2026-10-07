# perm-solve

权限变更候选的最小费用子集选择 CLI。给定至多 18 条候选规则（allow/deny + 费用 + 匹配模式）
与一组 allow/deny 样例，求满足所有样例的费用最小规则子集；规则冲突时 **拒绝优先**，
无规则匹配时默认拒绝。每个样例输出判定证据，并对小候选集做全枚举核对最优性与无解结论。

仅使用 TypeScript + Node.js 内置库（`node:fs`、`node:test`、`node:assert`），无运行时依赖。

## 规则模型

- 候选规则：`{ id, action: "allow"|"deny", cost: 非负整数, match: { subject, op, resource } }`
- 匹配字段支持精确串与 `*` 通配（如 `secret/*`），缺省为 `*`
- 判定：任一匹配的 deny 规则存在 → deny；否则任一匹配的 allow 规则存在 → allow；否则默认 deny
- 样例：`{ id, expect: "allow"|"deny", request: { subject, op, resource } }`
- 目标：选中子集使所有样例的实际判定等于期望，且总费用最小
  （平局时依次偏好规则数更少、位掩码更小，保证结果确定）

## 求解与核对

- 主求解器：分支定界（`solveBranchAndBound`），利用费用下界与
  “期望 allow 的样例一旦匹配 deny 即不可修复” 剪枝
- 核对器：全枚举（`solveBruteForce`），候选 ≤ 18 时枚举全部至多 2^18 = 262144 个子集，
  验证最优解费用一致；两者均判定不可行时确认无解；不一致时 CLI 以退出码 3 报错

## 使用

```sh
npm test                                  # 编译并运行全部测试
npm run solve -- examples/feasible.json   # 求解示例（文本报告）
node dist/src/cli.js - --json < input.json  # 从 stdin 读取，JSON 输出
```

退出码：0 = 已找到最优解并通过全枚举核对；1 = 无解（全枚举确认）；2 = 输入非法；3 = 求解器与枚举不一致。

## 实际运行结果（2026-10-07，Node v22.22.1，tsc 7.0.2）

`npm test`：exit=0，2 个测试文件、21 个用例全部通过：

```
ok 1 - matchGlob supports exact, wildcard and prefix glob
ok 2 - decide: deny wins over allow on conflict
ok 3 - decide: default is deny when nothing matches
ok 4 - decide: allow when only allow rules match
ok 5 - solver finds known minimum-cost subset
ok 6 - branch-and-bound agrees with brute force on the example
ok 7 - evidence explains every sample and all pass
ok 8 - infeasible problem is reported by both solvers
ok 9 - tie-break prefers fewer rules then lower mask
ok 10 - empty candidate set: feasible only if all samples expect deny
ok 11 - randomized cross-check: branch-and-bound equals brute force   (400 组种子随机用例)
ok 12 - 18 candidates: full enumeration of 262144 subsets agrees with solver
ok 13 - parseProblem rejects more than 18 candidates
ok 14 - parseProblem rejects invalid input shapes
ok 1..7 - cli.* (可行/无解/超限/JSON/stdin/用法/帮助)
# pass 21  # fail 0
```

`node dist/src/cli.js examples/feasible.json`（exit=0）：

```
Status: OPTIMAL
Total cost: 6
Selected rules (3): allow-all-read(allow,cost=1), deny-secret(deny,cost=1), allow-alice-write(allow,cost=4)
Subset mask: 10110

Evidence per sample:
  [OK] sample s1: expect=allow decision=allow
    matched rule: allow-all-read (allow, cost=1)
  [OK] sample s2: expect=deny decision=deny
    matched rule: allow-all-read (allow, cost=1)
    matched rule: deny-secret (deny, cost=1)
    conflict resolution: deny wins
  [OK] sample s3: expect=allow decision=allow
    matched rule: allow-all-read (allow, cost=1)
  [OK] sample s4: expect=deny decision=deny
    matched rules: (none, default deny)
  [OK] sample s5: expect=allow decision=allow
    matched rule: allow-alice-write (allow, cost=4)

Verification: exhaustive enumeration of 32 subsets -> best cost 6, mask 10110; branch-and-bound AGREES.
```

`node dist/src/cli.js examples/infeasible.json`（exit=1）：

```
Status: INFEASIBLE
Verification: exhaustive enumeration of 4 subsets confirms no subset satisfies all samples.
```

无解示例说明：同一请求既期望 allow 又期望 deny；选 deny 规则则 allow 样例失败，
只选 allow 规则则 deny 样例失败，都不选则 allow 样例因默认拒绝失败——枚举全部 4 个子集确认无解。

## 目录结构

- `src/model.ts` — 类型、glob 匹配、拒绝优先判定、输入校验（≤18 候选）
- `src/solver.ts` — 分支定界求解、全枚举核对、逐样例证据
- `src/cli.ts` — CLI（文件/stdin 输入，文本/JSON 输出，可注入 IO 便于测试）
- `test/` — `node:test` 用例（含 400 组随机交叉核对与 18 候选全枚举）
- `examples/` — 可行与无解示例
- `types/shims.d.ts` — Node 内置模块的最小类型声明（环境无 @types/node）
