# rect-pack-cli

在至多 8×8 网格上放置至多 10 个给定矩形的精确求解 CLI：

- 每个矩形可按项配置是否允许旋转（`rotate`）
- 禁区格子（`forbidden`）不能被覆盖
- 目标：先最大化放入子集的总收益，再最小化覆盖的总格子数
- 输出格子占用证书（ASCII 网格 + 每个矩形的坐标，或 `--json`）
- 极小网格用独立的全枚举核对器验证解的可行性与最优性

仅使用 Node.js 内置库（`node:fs` 等），TypeScript 编写，`tsc` 编译。

## 输入格式

```json
{
  "grid": { "width": 6, "height": 5, "forbidden": [[2, 1], [3, 3]] },
  "items": [
    { "id": "A", "w": 3, "h": 2, "profit": 12, "rotate": true },
    { "id": "B", "w": 2, "h": 2, "profit": 9 }
  ]
}
```

坐标 0 起始，原点在左上角；`rotate` 缺省为 `false`。

## 用法

```bash
npm run build                                    # tsc 编译到 dist/
node dist/src/cli.js solve examples/sample.json  # 求解并输出占用证书
node dist/src/cli.js solve examples/sample.json --json --out cert.json
node dist/src/cli.js verify examples/sample.json # 强制全枚举核对
node dist/src/cli.js solve examples/large.json --no-verify
```

- 网格 ≤ 36 格时默认自动做全枚举核对（`--verify` 强制、`--no-verify` 关闭）。
- 全枚举核对器与求解器是两套独立实现：它枚举所有物品子集 × 所有放置组合，
  同时校验证书结构（不越界、不重叠、不压禁区、未擅自旋转、收益/面积一致）。
- 核对设有节点预算（默认 2000 万），超出则跳过并明确提示，证书结构校验仍然有效。

## 算法

求解器（`src/solver.ts`）：

1. 枚举全部 ≤ 2^10 个物品子集，按（收益降序、面积升序）排序，第一个可装箱的
   子集即最优解（面积平局在此天然解决）。
2. 子集可行性用 MRV 回溯判定：每次对当前合法放置数最少的物品分支。
3. 相同尺寸物品做对称性破除（同组物品放置锚点严格递增）。
4. 可行性只取决于各相同物品组的数量向量，按计数向量缓存结果——相同物品的
   不同子集共享同一份证明；不可行子集的所有超集直接跳过。

核对器（`src/verify.ts`）：独立风格的暴力全枚举 + 证书结构校验。

## 实测结果

`npm test`（tsc 编译 + node:test，共 18 个用例）全部通过：

```
# tests 3 个文件（solver / verify / cli）
# pass 18 / fail 0（3 个测试文件）
```

- 200 个随机小实例（≤5×5、≤6 物品）求解器 vs 全枚举逐一交叉核对：全部一致。
- 100 个随机 5–8 网格、6–10 物品实例：证书全部合法，最坏求解耗时 60ms。
- 对抗性压测（8×8 网格、10 个物品）：

| 用例 | 耗时 | 结果 |
|---|---|---|
| 10 个 3×3（最多放 4 个，经全枚举确认） | 94ms | profit=36 |
| 10 个 4×4 | 2ms | profit=64 |
| 10 个 2×2 + 6 个禁区 | 3ms | profit=40 |
| 10 个 5×3 可旋转 | 1ms | profit=60 |
| 混合尺寸/收益 10 物品（examples/large.json） | 3ms | profit=91 |

`examples/sample.json` 实际输出（6×5、2 个禁区、6 个物品）：

```
optimal: profit=44 area=25 placed=6/6
B B E A A A
B B # A A A
C C C C D D
. . . # D D
F F F F D D
verify: OK (exhaustive, 177224 nodes) profit=44 area=25
```

## 测试

```bash
npm test
```

覆盖：单物品放置、超尺寸跳过、按项旋转开关、禁区不覆盖、最大收益子集、
面积平局打破、负收益不放置、输入校验、证书篡改检测、随机交叉核对、
相同物品不同收益的重标签、10×(3×3) 压测、CLI 端到端（含 --json/--out/verify）。
