# int-dsp-chain

整数 FIR 滤波器与整数抽取器的级联信号处理库。TypeScript 编写，运行时只使用
Node.js 内置模块（`node:test` / `node:assert`），无任何第三方依赖。

```
src/types.ts      样本注解类型（time / srcFirst / srcLast）与旧尾策略类型
src/fir.ts        流式整数 FIR（支持按样本号调度配置切换）
src/decimator.ts  整数抽取器（计数器跨块、跨切换连续）
src/chain.ts      级联：块式喂入、延迟映射到原时间
src/model.ts      独立逐样本参考模型（用于交叉核对）
test/chain.test.ts  测试套件
```

## 语义约定

### 块边界不重置状态

所有状态（FIR 延迟线、抽取器计数器、待生效的切换表）都保存在各级实例内部。
`Chain.push(block)` 可以用任意大小、任意次数的块喂入，结果与一次性喂入完全
一致（有专门测试验证）。FIR 是因果的：每进入一个样本就产出一个样本，流开头
不足一个窗长的部分按零填充处理，不丢样本。

### 延迟映射到原时间

每个样本都带 `time` 字段，表示它在**原始输入时间轴**上的位置：

- 输入样本的 `time` 就是其输入序号；
- FIR 输出的 `time` 按其群延迟回标（默认 `(n-1)/2`，即线性相位滤波器的精确
  群延迟；偶数长度时为半样本，如 `10.5`）；延迟可用 `delay` 显式指定；
- 抽取器原样透传 `time`（自身延迟为 0）。

`chain.stageDelays()` 返回各级延迟换算到原时间后的值（该级局部延迟乘以其
前方累积抽取比），`chain.totalDelay()` 为总和，`chain.totalDecimation()` 为
总抽取比。因此冲激响应的峰会被标注在冲激进入的时刻，而不是它物理上流出的
时刻。流预热阶段（窗中心落在已知历史之前）的 `time` 按最近观测到的样本间隔
外推，属瞬态边缘样本，文档在此明示。

### 配置切换只在明确样本号生效

`fir.scheduleSwitch({ at, config, tail })` 与
`decimator.scheduleSwitch({ at, config })` 以**原始输入样本号** `at` 调度切换：

- 切换在该级收到的第一个 `time >= at` 的样本上生效，之前的样本完全不受影响；
- 切换表按样本号生效（同号按登记先后），与登记顺序无关；
- 登记时 `at` 已经过去，则下一个处理的样本即生效；
- `at` 超出流尾则切换永不生效；
- 抽取器切换时**计数器不复位**：新 `factor`/`phase` 作用于持续计数的局部序号。

### 旧尾如何处理（`tail`）

切换 FIR 系数时，延迟线里还留着旧样本（“旧尾”），两种公开策略：

- `'keep'`（默认）：保留延迟线。新系数立即作用于仍含旧样本的窗，因此切换后
  前 `n-1` 个输出是旧数据与新系数的混合瞬态。新滤波器变短则丢弃最旧的多余
  历史；变长则缺失的历史按零计（延迟线物理上只保存切换前 `n_old-1` 个样本）。
- `'zero'`：切换时刻清空延迟线。切换后前 `n-1` 个输出把切换前的历史视为零，
  且这些输出的 `srcFirst` 不再包含被清掉的样本。

### 输出来源范围

每个输出样本带 `srcFirst` / `srcLast`，标明其值由原始输入中哪个闭区间
`[srcFirst, srcLast]` 的样本贡献。区间随 FIR 窗滑动、随抽取透传、随 `'zero'`
切换收缩，可用于精确追溯任一输出的数据出处。

### 整数精确性

系数与输入必须是整数（非整数抛 `TypeError`）。全部算术在 `number` 上进行，
只要部分和不超过 `Number.MAX_SAFE_INTEGER`（2^53）结果就是精确的。

## 独立逐样本模型核对

`src/model.ts` 用完全不同的风格重新实现全部语义：不做流式状态机，而是对整段
数组逐级做直接卷积与抽取，逐样本、逐抽头循环。测试（固定种子的伪随机用例，
80 组随机级联、随机切换点、随机旧尾策略、随机块切分）将流式级联的输出与该
模型逐字段（`value` / `time` / `srcFirst` / `srcLast`）做精确相等断言。

## 用法

```ts
import { Chain } from './src/chain.js';
import { Fir } from './src/fir.js';
import { Decimator } from './src/decimator.js';

const fir = new Fir({ coeffs: [1, 2, 3, 2, 1] });   // 群延迟 2
fir.scheduleSwitch({ at: 1000, config: { coeffs: [1, 1, 1] }, tail: 'zero' });

const chain = new Chain([
  fir,
  new Decimator({ factor: 4, phase: 0 }),
  new Fir({ coeffs: [1, 1, 1] }),                    // 局部延迟 1 = 原时间 4
]);

const out = chain.push([1, 2, 3, 4, 5, 6, 7, 8]);
// out[i] = { value, time, srcFirst, srcLast }
console.log(chain.stageDelays()); // [ 2, 0, 4 ]
console.log(chain.totalDelay());  // 6
```

## 运行测试

```sh
npm test    # tsc 编译 + node --test（仅 Node 内置模块）
```

需要 Node.js（>= 18）与可用的 `tsc`（TypeScript 编译器，仅开发期使用）。

## 实际测试记录

在本机环境（Node.js v22.22.1，tsc 7.0.2）执行 `npm test`，实际输出：

```
# tests 12
# pass 12
# fail 0
```

12 个用例全部通过：

```
ok 1 - block boundaries never reset state
ok 2 - streaming chain matches the independent per-sample model
ok 3 - stage delays map to original time (impulse response)
ok 4 - half-sample delay of even-length filters maps to fractional time
ok 5 - config switch takes effect exactly at the scheduled sample number
ok 6 - switch scheduled beyond the stream end never applies
ok 7 - old-tail policy: keep mixes old samples with new coefficients
ok 8 - old-tail policy: zero clears the delay line at the switch
ok 9 - output samples report their original-input source range
ok 10 - decimator switch applies at the scheduled sample, counter keeps running
ok 11 - integer arithmetic is exact within the safe-integer range
ok 12 - non-integer coefficients, inputs and switch points are rejected
```
