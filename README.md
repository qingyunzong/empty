# curve-line-roots

精确求“有理控制点三次参数曲线样条（≤8 段）与直线”的全部参数根：输出每个根的
隔离区间与重数；若整段曲线落在直线上，报告该段的参数区间。全程使用 BigInt 精确
有理数运算，根计数基于 Bernstein 系数符号变差（Descartes 规则），**不以采样代替
根计数**；隔离预算耗尽而未闭合的区域标记为 `unknown`。

## 方法

1. 直线 `a·x + b·y + c = 0` 代入每段三次 Bézier 曲线，得到 `[0,1]` 上的三次多项式
   `f(t)`（Bernstein 系数 `b_i = a·x_i + b·y_i + c`，精确有理数）。
2. `f ≡ 0`（所有 Bernstein 系数为 0）→ 整段在线上，报告区间 `[0,1]`。
3. 重根：`g = gcd(f, f')`。三次多项式的重根必为有理数，故二重/三重根连同重数
   （`f` 在该点的零化阶）被**精确**求出，并从 `f` 中 deflate。
4. 单根：对剩余无平方因子部分在 `[0,1]` 上做精确二分（de Casteljau 细分 +
   符号变差计数）。变差为 0 无根，为 1 恰一根；细分中点若恰为根（二分点）则精确
   记录。区间宽度 ≤ `tol`（默认 2⁻²⁴）即输出隔离区间。
5. 预算：每个隔离节点消耗 1 单位预算（默认 100000，全局共享）。预算耗尽时，未
   闭合的节点连同其根数上界（符号变差）进入 `unknown`，`budget.closed = false`。

## 输入（JSON，文件路径作为参数或 stdin）

```json
{
  "segments": [{ "points": [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] }],
  "line": { "a": 0, "b": 1, "c": 0 },
  "budget": 100000,
  "tol": "1/16777216"
}
```

- `segments`：1–8 段，每段 4 个控制点；坐标为有理数，可写整数、`"p/q"`、
  小数字符串或 `[p, q]`。
- 全局参数 `T = 段号 + t`，`t ∈ [0,1]` 为段内参数。

## 输出

- `roots[]`：`{segment, multiplicity, exact, t:[lo,hi], globalT:[lo,hi]}`；
  `exact=true` 表示区间退化为精确有理点。
- `onLine[]`：整段在线上的 `{segment, t:["0","1"], globalT}`。
- `unknown[]`：预算未闭合区域 `{segment, t:[lo,hi], globalT, maxRoots}`。
- `budget`：`{limit, used, closed}`。

## 使用

```sh
npm test                 # 编译并运行全部验收测试（已知根构造）
npm run solve -- example.json   # 或: node dist/src/cli.js < input.json
```

测试全部以已知根构造验收：三个单根（二进/非二进有理点）、二重根、三重根、
端点重根、整段共线、多段样条全局参数、无交、预算耗尽标记未知、段数上限校验。
