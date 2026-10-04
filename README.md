# 字幕层调度器（subtitle-layer-scheduler）

字幕库中每条字幕带**半开显示区间** `[start, end)` 与**优先级** `priority`。
在最多 **k 层**、**同层不重叠**的约束下，选出**总收益最大**的显示集合，
并输出**层分配证书**。支持**更正时码后重算**，并用**小子集着色枚举**交叉核对。
纯 TypeScript + Node.js 内置库，零运行时依赖。

## 规则

- 半开区间：`end == start` 的两条字幕相接不重叠，可同层复用。
- 至多 20 条字幕（`MAX_ITEMS`），id 唯一整数，`end > start`。
- 并列 ID 序：总收益相同的多解之间，按 id 升序逐位比较（特征向量规则）——
  首个出现差异的 id，**包含该 id 的集合胜出**（即优先保留较小 id）。
  该规则用 BigInt 权重 `cost = -(priority * 2^(n+1) + 2^(n-rank))` 精确编码进求解器，
  与暴力枚举的比较器完全一致。

## 算法

- **主求解器** `solve(items, k)`（`src/solver.ts`）：时间轴压缩图上的最小费用流。
  相邻时刻边容量 k、费用 0；每条字幕一条 `start -> end` 容量 1、费用为负收益的边。
  每次沿最短路增广 1 单位（一条层的排期），最多 k 次，故任意时刻选中数 <= k。
- **层分配** `assignLayers`：区间图贪心染色，颜色数 == 最大重叠深度，保证 <= k。
- **证书校验** `verifyCertificate`（`src/certificate.ts`）：检查 id 合法、层号越界、
  同层两两不重叠、收益与条数一致。
- **时码更正** `applyCorrections`（`src/corrections.ts`）：按 id 覆盖 start/end/priority，
  重新校验后再调用 `solve` 重算。
- **枚举核对** `bruteForce`（`src/brute.ts`）：枚举全部 2^n 子集（n <= 20），
  用着色数（== 最大深度）判定可行性，取收益最大、并列按 ID 序的最优集。

## 使用

```bash
npm test                 # 编译 + 运行全部测试
npm run typecheck        # 仅类型检查
npm run build            # 编译到 dist/
npm run solve --silent examples/sample.json   # 求解并输出证书（含更正后重算）
cat input.json | npm run solve --silent       # 也可从 stdin 读入
```

输入 JSON：`{ "k": 2, "items": [{ "id", "start", "end", "priority" }...],
"corrections": [{ "id", "start"?, "end"?, "priority"? }...] }`（corrections 可选）。
输出：`solution` 证书；有 corrections 时附 `corrected` 重算证书。

## 示例（examples/sample.json 实际输出）

k=2，5 条字幕。原始数据下 id=2 与 id=3 在 [3,4) 处形成 3 层重叠，
舍弃收益最低的 id=2，收益 19；更正 id=3 的 start 为 4 后 5 条全部可容纳，收益 23：

```json
{
  "solution":  { "k": 2, "profit": 19, "count": 4, "selected": [1, 3, 4, 5],
                 "assignment": [{"id":1,"layer":0},{"id":3,"layer":1},{"id":4,"layer":0},{"id":5,"layer":1}] },
  "corrected": { "k": 2, "profit": 23, "count": 5, "selected": [1, 2, 3, 4, 5],
                 "assignment": [{"id":1,"layer":0},{"id":2,"layer":1},{"id":3,"layer":1},{"id":4,"layer":0},{"id":5,"layer":1}] }
}
```

## 测试结果（实际运行记录）

环境：Node.js v22.22.1，npm 9.2.0，tsc 7.0.2（全局）。`npm test` 输出：

```
ok 1 - k=1 经典加权区间调度
ok 2 - 半开区间：end == start 可同层相接
ok 3 - k=2 允许两个重叠字幕各占一层
ok 4 - 并列 ID 序：收益相同优先包含较小 id
ok 5 - 并列 ID 序：跨位置比较（特征向量规则）
ok 6 - 证书校验：篡改同层重叠与收益被拒
ok 7 - 更正时码后重算：修正 end 解除冲突，收益上升
ok 8 - 更正未知 id 与非法时码报错
ok 9 - 输入校验：超 20 项、区间非法、id 重复
ok 10 - 着色数 == 最大重叠深度（区间图）
ok 11 - 小子集枚举核对：solve 与 bruteForce 一致
ok 12 - 边界：空库与 k=0
ok 13 - assignLayers 颜色数不超过 k 且同层不重叠
# tests 13
# pass 13
# fail 0
```

其中测试 10 用 200 组随机子集验证贪心着色数恒等于扫描线最大深度；
测试 11 用 4 组种子 x 60 组随机小输入（n <= 10）逐位比对
`solve` 与 `bruteForce` 的收益与选中集合，全部一致。

## 备注

- 本机 Node 构建未启用 TypeScript 类型擦除（`ERR_NO_TYPESCRIPT`），
  故 `npm test` 先用全局 `tsc` 编译到 `dist/` 再运行测试。
- 零依赖，未安装 `@types/node`；`types/node.d.ts` 仅声明用到的内置 API 子集。
