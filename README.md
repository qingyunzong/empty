# oven-control

单机离线 Node.js 22 烘箱温控指令库与 CLI。全部计算使用 BigInt 精确有理数，
禁止浮点；多项式次数 ≤ 4。

## 模型

- 温区多项式 `P(x)`，有理系数，输入区间 `[lo, hi]` 为有理数。
- 精确极值：比较端点与导数的**全部有理驻点**（有理根定理枚举，BigInt 精确验证）。
- 量化：指令值按 `10^-k` 刻度四舍五入、**半值向上**（朝 +∞）。
  仅当整个值区间舍入到同一刻度时接受，否则抛 `E_AMBIGUOUS`。
- 结果含精确值区间、量化值与严格误差界
  `err = max(q - min, max - q)`（区间内任意值到输出值的最大距离）。
- 系数修订：事务提交（`begin/stage/commit`），非法事务不改变激活版本；
  历史支持 `undo`/`redo`。

## 错误码与退出码

| 错误码        | 含义                       | 退出码 |
| ------------- | -------------------------- | ------ |
| `E_CONFIG`    | k<0、次数>4、区间为空等    | 2      |
| `E_RATIONAL`  | 分母为 0、有理数格式非法   | 3      |
| `E_AMBIGUOUS` | 区间跨越多个量化刻度       | 4      |
| `E_STATE`     | 事务/历史状态非法          | 5      |

## CLI

```sh
node src/cli.js eval --coeffs "1/4,0,-2,0,1" --lo 9/10 --hi 11/10 -k 1
node src/cli.js init --coeffs "1/4,0,-2,0,1" --state oven-state.json
node src/cli.js stage --coeffs "3,0,-2,0,1" --state oven-state.json
node src/cli.js commit --state oven-state.json
node src/cli.js undo --state oven-state.json
node src/cli.js eval --lo 9/10 --hi 11/10 -k 1 --state oven-state.json
```

系数与区间只接受精确有理数（`3`、`-2`、`3/4`），不接受小数/浮点。

## 库

```js
import { computeInstruction, OvenStore, Polynomial, Rat } from './src/index.js';

const r = computeInstruction(['1/4', '0', '-2', '0', '1'], '9/10', '11/10', 1);
// r.interval.min/max, r.quantized, r.errorBound 均为精确 Rat
```

## 测试

```sh
node --test
```
