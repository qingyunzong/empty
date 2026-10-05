# teamforge — 精确最省费用组队 CLI

从至多 24 人、12 种技能中选出满足约束的最优团队：

- 每种技能 `s` 的队内人数 `>= minSkills[s]`（最低各技能人数）
- 禁对（forbidden pairs）中的两人不得同时入队
- 优化顺序：总费用最小 → 团队人数最少 → 排序后 ID 集合字典序最小

仅使用 TypeScript + Node.js 内置模块（`node:fs`、`node:test` 等），零运行时依赖、零 npm 安装。

## 输入格式（JSON）

```json
{
  "people": [
    { "id": "ana", "skills": ["backend"], "cost": 5 }
  ],
  "forbiddenPairs": [["ana", "bo"]],
  "minSkills": { "backend": 1, "devops": 1 }
}
```

- `people`：0–24 人；`id` 为字符串或数字（内部统一按字符串处理、去重）；`cost >= 0`；`skills` 可省略
- `forbiddenPairs`：可省略；端点必须已知、不得自配对、不得重复
- `minSkills`：可省略；值为 `>= 0` 的整数；可引用无人具备的技能（会导致无解）
- 全部不同技能（人员技能 ∪ minSkills 键）至多 12 种

## 使用

```bash
npm test                              # 构建并运行全部测试
npm start -- examples/sample.json     # 求解示例
node dist/src/cli.js input.json       # 构建后直接运行
node dist/src/cli.js - < input.json   # 从标准输入读取
node dist/src/cli.js input.json --verify   # 小实例枚举全部团队交叉核对
node dist/src/cli.js input.json --json     # 机器可读报告
```

退出码：`0` 已求出最优解且证书全部通过；`1` 无可行团队；`2` 输入非法；`3` 证书或枚举核对失败。

## 输出

报告包含：最优团队费用/人数/成员、**技能计数**（每技能实际人数 vs 最低要求）、
**禁对检查证书**（逐对列出两人是否入队及 OK/FAIL），以及 `--verify` 时的
枚举核对行（枚举团队总数、可行团队数、最优解一致确认）。
证书由独立模块对结果重新逐项校验，不依赖求解器内部状态。

示例（`examples/sample.json --verify`）实际输出：

```
Optimal team: cost=11, size=2
Members: cy, di

Skill counts:
  backend: 1 (min 1) OK
  devops: 1 (min 1) OK
  frontend: 1 (min 1) OK

Forbidden-pair certificate (1 pair):
  ana ~ bo: ana=out, bo=out OK
Certificate: ALL CHECKS PASSED
Exhaustive verification: 32 teams enumerated, 11 feasible, optimum confirmed
```

## 算法

- `src/solve.ts`：分支定界。按费用升序访问人员以尽早收紧上界；两类剪枝——
  (1) 可行性：任一技能「当前人数 + 后缀剩余可提供人数 < 最低要求」即剪；
  (2) 上界：当前费用已超最优，或费用持平且人数不可能更优时剪（平局时仅评估当前集合本身）。
  候选比较器即题目优化顺序（费用、人数、排序 ID 字典序）。
- `src/enumerate.ts`：对全部 `2^n` 个子集逐一判定可行性并用同一比较器取最优，
  用于小实例（`--verify` 及随机化测试）对分支定界结果做完整核对。
- `src/certificate.ts`：独立重算技能计数与禁对状态，输出证书。

## 测试结果（实际运行记录）

环境：Node.js v22.22.1，TypeScript 编译器 7.0.2。`npm test` 实际结果：

```
ok 1 - dist/test/cli.test.js
ok 2 - dist/test/parse.test.js
ok 3 - dist/test/solve.test.js
# tests 3
# pass 3
# fail 0
```

逐文件明细（共 23 个用例，全部通过）：

| 文件 | 用例数 | 通过 |
| --- | --- | --- |
| `test/solve.test.ts` | 10 | 10 |
| `test/parse.test.ts` | 8 | 8 |
| `test/cli.test.ts` | 5 | 5 |

要点：

- `solve.test.ts` 含 300 个随机种子实例（1–14 人、至多 6 技能、随机禁对与最低人数），
  分支定界结果与全量枚举逐一比对费用/人数/ID 集合，全部一致；
  另有 24 人 × 12 技能（全技能最低 1 人）实例的求解与证书校验。
- `parse.test.ts` 覆盖超限（>24 人、>12 技能）、重复 ID、负费用、未知禁对端点、
  自配对、重复禁对、非法 minSkills 等输入校验。
- `cli.test.ts` 端到端验证退出码、文本报告、JSON 报告、标准输入与枚举核对行。

注：本沙箱环境不传递 `spawnSync` 的子进程管道输出，CLI 测试改用临时文件重定向捕获输出。
