# rect-pack-cli

在至多 **8x8** 的网格上放置至多 **10 个**给定矩形（可按项配置是否允许旋转 90°，
禁区格子不可覆盖），选出**总收益最大**的子集，收益相同时取**总面积最小**者。
输出格子占用证书并自校验；极小网格自动用独立的全枚举实现核对可行性与最优性。

仅使用 TypeScript + Node.js 内置库，零运行时依赖。

## 用法

```bash
npm run build                          # 编译到 dist/
node dist/src/cli.js <input.json>      # 求解并输出占用证书
node dist/src/cli.js examples/demo.json --exhaustive on
npm test                               # 构建并运行全部测试
```

选项：

- `--exhaustive auto|on|off`：全枚举核对。`auto`（默认）在格子数 ≤24 且矩形 ≤7 时启用。
- `--budget N`：搜索节点预算，默认 50000000，超出后以退出码 3 报错。

退出码：`0` 成功；`1` 用法错误；`2` 输入非法；`3` 超预算；`4` 全枚举核对不一致；`5` 证书校验失败。

## 输入格式

```json
{
  "grid": { "width": 8, "height": 8, "forbidden": [[3, 3], [4, 3]] },
  "rectangles": [
    { "id": "r1", "w": 4, "h": 2, "profit": 14, "rotate": true }
  ]
}
```

- `grid.width/height`：1–8 的整数；`forbidden` 为禁区格子 `[x, y]`（0 起始，可省略）。
- `rectangles`：至多 10 个；`w/h` 为正整数；`profit` 非负；`rotate` 缺省 `false`。

## 算法

1. **子集枚举**：矩形 ≤10 个，枚举全部 2^n（≤1024）个子集，
   按（收益降序，面积升序）排序；第一个可放置的子集即（最大收益，最小面积）最优解。
2. **放置判定**（`src/solver.ts` 的 `placeSubset`）：位掩码（BigInt）回溯，
   按静态最少放置数排序选矩形、前向检查剪枝；相同规格矩形强制放置序号递增，
   消除排列对称性（10 个相同 1x1 矩形也不会组合爆炸）。
3. **证书校验**（`src/certificate.ts` 的 `verifyCertificate`）：独立复查尺寸/旋转合法性、
   边界、禁区、重叠及收益面积账目。
4. **全枚举核对**（`src/exhaustive.ts`）：与主求解器不同实现的朴素固定顺序回溯，
   遍历全部子集求最优值，与主求解器结果比对（极小网格自动启用）。

## 实测结果（2026-10-05, Node v22.22.1, tsc 7.0.2）

`npm test`：**3 个测试文件全部通过**（solver 11 项 + parse 4 项 + cli 4 项断言，
含 40 个随机极小实例与全枚举核对器逐一比对一致）：

```
# tests 3
# pass 3
# fail 0
```

`node dist/src/cli.js examples/small.json`（4x4，1 格禁区，5 矩形）：

```
最优收益: 25  总面积: 13  放置: 4/5
占用证书 (#=禁区, .=空格):
E D C C
E # C C
E A A .
E A A .
证书校验: 通过
全枚举核对: 通过（32 个子集, 75 节点, 收益/面积一致）
```

`node dist/src/cli.js examples/demo.json`（8x8，中央 2x2 禁区，10 矩形）：
约 33 ms，尝试 105/1024 个子集；最优收益 68、面积 38、放置 9/10
（5x5 的 r2 被最优地舍弃）；`--exhaustive on` 强制全枚举 1024 个子集、
6385 节点，结果一致，全程约 0.36 s。

```
最优收益: 68  总面积: 38  放置: 9/10
占用证书 (#=禁区, .=空格):
D D D D D D C C
F F A A A A C C
F F A A A A H H
J G I # # E E E
. G I # # E E E
. G I . . . . .
. G . . . . . .
. . . . . . . .
证书校验: 通过
```

## 目录结构

- `src/parse.ts` — 输入解析与约束校验（8x8 / 10 矩形上限）
- `src/solver.ts` — 位掩码放置 + 子集枚举主求解器
- `src/exhaustive.ts` — 独立全枚举核对器
- `src/certificate.ts` — 占用证书渲染与校验
- `src/cli.ts` — 命令行入口
- `test/` — node:test 测试；`examples/` — 示例实例
- `types/node-shim.d.ts` — 离线环境的最小 Node 类型声明（有网时可换 `@types/node`）
