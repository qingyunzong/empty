# 实际运行结果

环境：Node.js v22.22.1，tsc 7.0.2，Linux x86_64。运行日期：2026-10-05。

## npm test

命令：`tsc -p tsconfig.build.json && node --no-warnings --test dist/test/*.test.js`

```
ok 1 - dist/test/certificate.test.js
ok 2 - dist/test/crosscheck.test.js
ok 3 - dist/test/model.test.js
ok 4 - dist/test/solver.test.js
# tests 4
# pass 4
# fail 0
```

覆盖内容：

- `test/model.test.ts`：合法布局通过校验、边贴边不算重叠、重叠/尺寸越界/
  网格越界/pair 与 fixed 对齐违例均被检出、移动距离求和正确。
- `test/solver.test.ts`：两矩形重叠的最小分离（目标 1）、fixed 对齐钉边（目标 3）、
  pair 对齐最小代价（目标 2）、不可行实例识别、零移动实例、
  节点预算下 `budget_exhausted` 且上下界一致。
- `test/crosscheck.test.ts`：8 个随机微小网格实例（grid 4、3 矩形）+
  含对齐约束的 2 个实例（grid 5）上，分支定界目标值与全枚举穷举最优值逐一相等。
- `test/certificate.test.ts`：最优证书复验零问题；篡改上界/翻转检查项/
  移动矩形/伪造最优状态均被拒绝；预算耗尽证书保持 `lowerBound ≤ upperBound`、gap > 0。

`npm run typecheck`（`tsc --noEmit`，strict）同样通过。

## npm start（演示实际输出）

```
=== Demo A: 4 rects, grid 20, optimal ===
status=optimal lowerBound=3 upperBound=3 gap=0 nodes=7
layout={"A":{"x":2,"y":2,"w":2,"h":2},"B":{"x":4,"y":3,"w":2,"h":2},"C":{"x":2,"y":4,"w":2,"h":2},"D":{"x":12,"y":8,"w":3,"h":2}}
constraint checks: 17/17 passed; verification issues: 0

=== Demo B: 8 rects, grid 20, budgeted ===
status=budget_exhausted lowerBound=5 upperBound=12 gap=7 nodes=2000
layout={"R0":{"x":6,"y":6,"w":2,"h":2},...,"R7":{"x":7,"y":10,"w":2,"h":2}}
constraint checks: 46/46 passed; verification issues: 0

=== Demo C: tiny-grid exhaustive cross-check ===
solver:   status=optimal objective=3 nodes=5
brute:    feasible=true objective=3 validLayouts=14
match:    true
solver layout valid: true
```

- Demo A：4 矩形、网格 20、含 3 条对齐约束，预算内闭合到最优（gap = 0）。
- Demo B：8 矩形、网格 20、节点预算 2000 未闭合，证书保留认证区间 [5, 12]。
- Demo C：微小网格（grid 4、3 矩形）上求解器目标值 3 与穷举最优值 3 一致。
