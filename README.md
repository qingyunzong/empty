# team-builder-cli

组队优化 CLI：在至多 **24 人**、至多 **12 种技能**的约束下，兼容**禁对**
（forbidden pairs）、**各技能最低人数**与**费用**，求最优团队。

- 目标：总费用最小；并列时人数更少者优先；再并列时按排序后的 ID 列表
  字典序最小者优先。
- 输出：最优团队、技能计数与禁对检查证书（certificate）。
- 小实例核对：内置全量枚举求解器，`--verify` 可与分支定界互相校验；
  测试中对 500 个随机小实例及 1 个 20 人实例做了全量枚举比对。
- 仅使用 Node.js 内置模块，零运行时依赖；TypeScript 编写，`tsc` 编译。

## 环境要求

- Node.js（开发使用 v22.22.1）
- TypeScript 编译器 `tsc`（开发使用 7.0.2；仅构建/测试时需要）

## 构建与测试

```sh
npm run build   # tsc -p tsconfig.json -> dist/
npm test        # 先编译，再运行 node --test "dist/test/*.test.js"
```

## 输入格式（JSON）

```json
{
  "people": [
    { "id": "alice", "skills": ["backend", "devops"], "cost": 9 }
  ],
  "forbiddenPairs": [["alice", "bob"]],
  "required": { "backend": 1, "frontend": 1 }
}
```

- `people`：0–24 人；`id` 为字符串或数字（内部统一按字符串比较），
  `skills` 省略视为无技能，`cost` 省略视为 0，必须是非负有限数。
- 技能全集 = 人员技能与 `required` 键的并集，至多 12 种。
- `forbiddenPairs`：可选，禁对双方不得同时入选；引用未知 ID 会报错。
- `required`：可选，每个技能的最低人数（非负整数），缺省为 0。

## 用法

```sh
node dist/src/cli.js examples/example.json            # 从文件读取
cat examples/example.json | node dist/src/cli.js      # 从 stdin 读取
node dist/src/cli.js input.json --verify              # 与枚举求解器交叉核对
node dist/src/cli.js input.json --brute               # 直接使用全量枚举
```

退出码：`0` 可行；`2` 不可行；`1` 输入/运行错误。

## 输出格式

```json
{
  "feasible": true,
  "cost": 14,
  "size": 3,
  "team": ["bob", "carol", "frank"],
  "certificate": {
    "skillCounts": { "backend": 1, "frontend": 1 },
    "skillChecks": [{ "skill": "backend", "required": 1, "actual": 1, "ok": true }],
    "forbiddenPairChecks": [
      { "pair": ["alice", "bob"], "membersInTeam": ["bob"], "ok": true }
    ],
    "verified": true
  },
  "crossCheck": { "method": "exhaustive-enumeration", "agreement": true }
}
```

证书逐项给出每个技能的`要求/实际`人数与每个禁对的两方入选情况，
`verified` 为全部约束满足时才为 `true`；`verifyCertificate` 会依据团队
名单独立重算并比对整份证书，可检测篡改。

## 求解器

- `src/solve.ts`：精确分支定界。费用非负，当前部分费用即下界；另按
  各技能“已选人数 + 剩余可选人数 < 最低要求”剪枝。候选团队按
  （费用， 人数， 排序 ID 列表）全序比较，保证平局规则精确成立。
- `src/brute.ts`：全量枚举 2^n 个团队（≤26 人），用于小实例核对。

## 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：

```
> team-builder-cli@1.0.0 pretest
> tsc -p tsconfig.json

> team-builder-cli@1.0.0 test
> node --test "dist/test/*.test.js"

ok 1 - dist/test/solver.test.js
# pass 1
# fail 0
```

`node dist/test/solver.test.js`（展开 12 个用例，全部通过）：

```
ok 1 - picks the minimum-cost team
ok 2 - tie-breaks by smaller team size
ok 3 - tie-breaks by lexicographically smaller sorted id list
ok 4 - respects forbidden pairs
ok 5 - reports infeasible when a skill minimum is unreachable
ok 6 - reports infeasible when forbidden pairs block every team
ok 7 - empty problem with no requirements yields the empty team
ok 8 - rejects invalid input
ok 9 - certificate verification detects tampering
ok 10 - branch-and-bound matches exhaustive enumeration on random small instances
ok 11 - solves a maximum-size instance (24 people, 12 skills)
ok 12 - branch-and-bound matches enumeration at 20 people
# tests 12
# pass 12
# fail 0
```

`node dist/src/cli.js examples/example.json --verify`（节选）：

```
"feasible": true, "cost": 14, "size": 3, "team": ["bob", "carol", "frank"]
"certificate": { ..., "verified": true }
"crossCheck": { "method": "exhaustive-enumeration", "agreement": true }
```

`node dist/src/cli.js examples/infeasible.json` → `{"feasible": false}`，退出码 2。

24 人 / 12 技能随机实例求解耗时（分支定界）：5 个种子 10–58ms；
对抗性实例（统一费用、每技能至少 3 人）43ms。
