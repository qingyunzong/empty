# 十进制128列的量化与非规范零

文档库采集宿主需要把BID式十进制128字段按目标量纲对齐，不能经过Number再转回导致34位系数或负零丢失。开发TypeScript可导入的16字节字段包，仅采用本题闭合位契约：字节按小端解释为128位U，h为高64位、l为低64位，sign取h位63，combo=(h右移58)与31。combo=30是带符号无穷，31是NaN，两者保留全部原始16字节，不解释载荷；其他为有限数。若(h右移61)与3等于3，则e=((h右移47)与16383)-6176且系数C视为0，标记nonCanonical=true；否则e=((h右移49)与16383)-6176，C=((h与(2^49-1))左移64)或l，若C>10^34-1同样按0解释并标记nonCanonical，不能报成巨大数；其余nonCanonical=false。有限值精确为(-1)^sign*C*10^e，零仍保留sign和e。提供Create(sign,C,e)，只接受C在0..10^34-1、e在[-6176,6111]，产生规范普通布局h=sign*2^63+(e+6176)*2^49+系数高49位及l，不自行删除系数尾零或更改量子。Quantize给有限输入、目标q在[-6176,6111]和模式towardZero、towardPositive、towardNegative、nearestEven、nearestAway之一，结果指数必须恰为q。e>=q时C乘10^(e-q)；e<q时按10^(q-e)除为商a和余r，向零不加，向正或向负仅在r>0且数值符号对应方向时给a加1，nearestEven在2r>除数或相等且a奇时加1，nearestAway在2r>=除数时加1。符号独立保留，即使舍入到0也保留负号，不能让负数向正舍入变成正的非零系数。若最终系数超过34位，返回invalidQuantize且无结果字节，不改指数去偷偷容纳，也不变成无穷；特殊值Quantize返回notFinite及原字节，NaN不参与舍入。成功结果额外给rounded=(原e<q)、inexact=(本次r不为0)，定义仅按本题，不宣称完整IEEE异常标志；e>=q令r=0。对非规范输入先按有符号零量化，但结果仍报告来源nonCanonical。另给NumericCompare：有限值按精确十进制比较，不同(C,e)同值应相等，正负零相等，负无穷小于所有有限值、正无穷大于所有有限值，同号无穷相等，任一NaN返回unordered，不能按原128位或字符串字典序排序。返回原始字节回取接口必须逐字保留NaN载荷及非规范有限编码；Quantize输出另建字段，不能覆盖原始快照。给真实采集宿主调用例，用独立大整数分子/分母参考核对全部舍入模式及比较；覆盖34位极值、最大系数加1编码成非规范零、steering分支、带指数的负零、正负半途偶奇、精确删除尾零时rounded真而inexact假、量化进位到35位失败、很小非零向0舍入、两端指数、同值不同量子及特殊值原始字节往返。不依赖数据库服务、Decimal库或宿主浮点，整数计算可用BigInt。

## 实现

- `src/bid128.ts` — 闭合位契约的字段包，所有整数运算仅使用 `bigint`，不经过 `Number`。
  - `Bid128Field` / `fromBytes`：不可变的 16 字节小端快照，`rawBytes()` 逐字回取，`parse()` 解码。
  - `Create(sign, coefficient, exponent)`：只接受 `coefficient ∈ [0, 10^34-1]`、`exponent ∈ [-6176, 6111]`，输出规范普通布局，不删尾零、不改量子。
  - `Quantize(field, q, mode)`：结果指数恰为 `q`；符号独立保留（负零舍入后仍为负）；返回判别联合 `ok | invalidQuantize | notFinite`，成功时附带 `rounded`、`inexact`、`sourceNonCanonical`，且结果是另建字段。
  - `NumericCompare(a, b)`：按精确十进制值比较，返回 `less | equal | greater | unordered`。
- `src/reference.ts` — 独立参考模型。比较用有符号分子/正分母有理数叉乘；量化独立重算整数商/余，不与被测包共用代码路径。
- `src/collector-host-example.ts` — 采集宿主调用例，逐行核对参考模型，失败时以非零码退出。
- `src/bid128.test.ts` — 15 组测试，覆盖题目列举的全部场景及全模式属性化交叉核对。

## 关键契约要点

- 无穷（combo=30）、NaN（combo=31）不解释载荷，原始 16 字节逐字保留。
- steering 分支（`(h>>61)&3 === 3`）与 `C > 10^34-1` 都解码为带符号、带指数的零并标记 `nonCanonical=true`，绝不报成巨大数。
- 量化后系数超过 34 位时返回 `invalidQuantize` 且无结果字节，不改指数、不变无穷。
- `rounded = (原 e < q)`；`inexact = (本次余数 r !== 0)`；`e >= q` 时令 `r = 0`。

## 运行

本环境的 Node 未编入内置 TypeScript 支持，因此先用全局 `tsc` 编译到 `dist/` 再运行（无第三方依赖）：

```sh
tsc -p tsconfig.json          # 仅类型检查
tsc -p tsconfig.test.json     # 编译到 dist/
node --test dist/src/bid128.test.js
node dist/src/collector-host-example.js
```
