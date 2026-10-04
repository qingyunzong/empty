# event-slicer

调试库事件读写状态单元的最小动态切片工具。给定一条事件轨迹（变量的
读/写、分支控制、输出），查询某个输出事件所依赖的**最小动态事件切片**：
覆盖写会去掉已无贡献的旧事件，控制依赖（`if` 谓词及其条件变量）保留；
删除切片外事件后回放，核对目标输出一致；并对切片的小子集做穷举验收，
确认任何更小的控制闭子集都无法复现输出。轨迹规模至 20 事件，穷举上界
2^20 个子集。

仅使用 TypeScript + Node.js 内置模块（`node:test`、`node:assert`），无第三方依赖。

## 事件模型（src/trace.ts）

```
const   x = <字面量>
compute x = add|sub|mul(a, b)
if (f) ... else ... end     结构化控制流
output(x)                   可观测输出
```

`replay(trace, keep?)` 回放（子集）轨迹：被删的 `if` 连同其控制框架消失，
被删的写事件移除其状态写入；读取未写入的变量会抛错（视为无法复现）。

## 切片算法（src/slice.ts）

经典动态切片，反向一趟扫描：

- 数据依赖：从目标输出出发维护"仍需变量"集合；遇到**实际执行过**的、
  写入仍需变量的事件则纳入切片，并杀死该变量——覆盖写使更早的旧写
  事件不再贡献，被排除（"覆盖写去掉已无贡献旧事件"）。
- 控制依赖：被纳入事件的外层 `if` 谓词传递性纳入（"控制依赖保留"），
  其条件变量进入仍需集合。
- 未执行的分支写、其它输出事件（仅观测）不进入切片。

## 验收（src/verify.ts）

`checkSlice(trace, target, slice)`：

1. **删除回放核对**：`projectMask` 为保留的 `if` 补回 `else`/`end` 结构，
   仅回放切片事件，目标输出值必须与完整轨迹一致。
2. **穷举最小性**：枚举切片的所有控制闭真子集（保留事件必须连带其
   控制谓词），逐一回放；任何一个能复现输出的即构成反例。切片 ≤ 20
   事件，最坏 2^20 子集。

## 随机验收生成器（src/gen.ts）

带种子（mulberry32）的随机轨迹生成器，保证穷举验收有意义：

- 读取只引用深度 0 已定义变量；分支体只写已定义变量；
- 每个变量的各次写入值互不相同（子集回退到旧写时值必不同）；
- 运算对每个操作数严格变化（`mul` 禁止 0 操作数、禁止 `sub(x,x)`）；
- 每个 `compute` 至少一个操作数取自"冻结变量"（只写一次、永不重写），
  使任何计算至多一个输入可能发散，两处发散无法相互抵消；
- `if` 条件使用只写一次的专用标志变量，谓词真值无法被子集静默改变。

这些约束使"依赖最小"与"值最小"一致，穷举验收才能严格成立。

## 使用

```
npm test     # tsc 编译 + node --test（12 个测试）
npm run demo # 示例轨迹的切片、删除回放与穷举验收演示
```

## 实际结果

环境：Node.js v22.22.1，tsc 7.0.2，Linux x86_64。

`npm test`（2026-10-05 实际运行）：

```
# tests 12
# pass 12
# fail 0
```

12 个测试：覆盖写去旧、数据链传递、自引用写、控制依赖保留（then/else/
嵌套/分支内输出）、其它输出事件排除、删除回放一致、验证器能识别非最小
候选集、非法目标报错，以及 500 条随机轨迹（≤20 事件）的穷举验收：

```
500 random traces: avg events 19.7, avg slice 4.1, max slice 13,
31048 control-closed subsets replayed, all minimal
```

`npm run demo`（实际输出节选）：15 事件示例轨迹，目标 `output(total)`，
切片 7 事件（含 `if (vip)` 控制依赖），删除 6 个无贡献事件后回放输出
6000 与原始一致，95 个控制闭真子集穷举均无法复现：

```
== minimal dynamic slice for output #14 (7 events) ==
  #0 balance = 1000
  #1 rate = 5
  #2 vip = 1
  #7 if (vip)
  #8 interest = mul(balance, rate)
  #12 total = add(balance, interest)
  #14 output(total)
deleted events: 6 of 15
target output after deletion: 6000 (original 6000)
reproduces: true
exhaustive minimality: true (95 control-closed proper subsets replayed)
```

## 已知边界

- 最小性是**依赖意义下**的最小：对任意轨迹，可能存在值上巧合复现输出
  的更小事件集（如乘法零元吸收、多处修改相互抵消、谓词只关心零/非零）。
  真正的值最小切片需要语义分析，超出动态依赖切片的范畴；随机验收通过
  上述生成器约束使两种最小性一致。
- `types/node-shim.d.ts` 是 `node:test`/`node:assert` 的最小离线类型声明
  （环境无网络，无法安装 @types/node）。
