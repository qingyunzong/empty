# weighted-fair-allocator

按**整数需求、权重、每户上限**分配总容量的分摊库:逐轮加权最大最小公平(渐进注水),
余数按用户 ID 顺序补分;支持需求撤销后重新分摊;输出逐轮饱和证据与精确分数应得,
并与逐单位小容量模型对照。仅使用 Node.js 内置库(`node:test` / `node:assert`),零第三方依赖。

## 环境

- Node.js >= 22,TypeScript 编译器(`tsc`,用于把 `.ts` 编译到 `dist/`)
- 无 npm 依赖,无需 `npm install`

## 命令

```bash
npm test         # 编译并运行 node:test 测试
npm run demo     # 运行演示场景(含撤销重分摊与模型对照)
npm run typecheck# tsc --noEmit 类型检查
```

## 分摊规则

1. 每户有效需求 = `min(demand, cap)`,权重必须为正数。
2. 水位(每单位权重的应得量)匀速上升,每户累计应得 = `min(有效需求, 水位 × 权重)`。
3. 每当水位达到某批用户的 `有效需求 / 权重`,这些用户在该轮**饱和**,记录为一轮证据。
4. 容量耗尽时水位停在中间,本轮无人饱和,分摊结束。
5. 最终分数应得向下取整;若容量仍是约束,取整余数按**用户 ID 字典序**逐户补 1。
6. 撤销需求(`Allocator.revoke`)后调用 `allocate()` 即按剩余用户重新分摊。

所有分数证据(`fractional`、各轮 `level`、`capacityRemaining`)用基于 `BigInt` 的
精确有理数(`src/rational.ts`)计算,以 `p/q` 字符串输出,无浮点舍入误差。

## API

```ts
import { allocate, Allocator } from './src/allocator.ts';
import { unitModelAllocate } from './src/unit-model.ts';
import { compareWithUnitModel } from './src/compare.ts';

const res = allocate(100, [
  { id: 'alpha', demand: 5,   weight: 1, cap: 10 },
  { id: 'beta',  demand: 50,  weight: 1, cap: 60 },
  { id: 'gamma', demand: 1000,weight: 1, cap: 1000 },
]);
// res.allocation  => { alpha: 5, beta: 48, gamma: 47 }
// res.fractional  => { alpha: '5', beta: '95/2', gamma: '95/2' }
// res.rounds      => 逐轮 { level, saturatedIds, capacityRemaining, cumulativeFractional }
// res.saturationRound => { alpha: 1 }   res.remainderRecipients => ['beta']

const allocator = new Allocator(100);
allocator.addUser({ id: 'A', demand: 4, weight: 1, cap: 4 });
allocator.revoke('A');            // 撤销需求
allocator.allocate();             // 重新分摊

compareWithUnitModel(capacity, users); // 与逐单位小容量模型逐户对照
```

## 文件结构

- `src/rational.ts` — 精确有理数(BigInt)
- `src/allocator.ts` — 逐轮加权最大最小公平分摊 + `Allocator`(撤销/重分摊)
- `src/unit-model.ts` — 逐单位小容量对照模型(每单位分给 已得/权重 最小者,ID 决胜)
- `src/compare.ts` — 两模型逐户对照报告
- `src/demo.ts` — 演示场景
- `test/allocator.test.ts` — 12 个测试(含 100 组确定性随机属性测试)

## 实际测试结果(2026-10-05,Node v22.22.1)

`npm test`(编译后 `node --test`)通过;逐条结果:

```
ok 1 - 加权最大最小公平:权重 1:3,饱和轮次与分数证据
ok 2 - 余数按 ID 顺序补分
ok 3 - 每户上限优先于需求生效
ok 4 - 容量充足时全部满足并报告未服务容量
ok 5 - 多轮饱和:逐轮水位、饱和用户与余数证据
ok 6 - 分数权重(0.5 : 1.5)精确分摊
ok 7 - 需求撤销后重新分摊
ok 8 - 非法输入一律拒绝
ok 9 - 逐单位小容量模型对照:固定案例完全一致
ok 10 - 逐单位小容量模型对照:加权案例完全一致
ok 11 - 分摊结果确定性:同一输入两次结果相同
ok 12 - 随机场景属性:守恒、上限、与逐单位模型偏差 <= 1
# tests 12
# pass 12
# fail 0
```

随机属性测试(种子固定,100 组)验证:整数分配总量 == `min(容量, 总有效需求)`;
分数应得之和同样守恒;每户不超上限;水位逐轮单调不减;逐轮模型与逐单位模型
总量一致且逐户最大偏差 <= 1。

`npm run demo` 实测输出(4 户、容量 100,含权重 3 的 delta):

```
=== 初始分摊 ===
  轮次 1: 水位=5      饱和=[alpha]  剩余容量=70
  轮次 2: 水位=40/3   饱和=[delta]  剩余容量=85/3
  轮次 3: 水位=55/2   饱和=[(无)]   剩余容量=0
  alpha: 5 (分数应得 5)   beta: 28 (55/2)   delta: 40 (40)   gamma: 27 (55/2)
  余数按 ID 补分接收者: beta
=== 与逐单位小容量模型对照 ===
  合计: 逐轮=100  逐单位=100  最大绝对差=0
>>> 撤销 'delta' 后重新分摊:alpha=5, beta=48, gamma=47(余数接收者 beta)
```
