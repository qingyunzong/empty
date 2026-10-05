# premul-layer-compositor

预乘 RGBA 图层合成库。TypeScript 编写，运行时仅依赖 Node.js 内置模块
（`node:test` / `node:assert`），无任何第三方依赖。

## 设计要点

- **整数分母预乘像素**（`src/pixel.ts`）：每个通道保存为整数分子 `n`，
  表示精确分数 `n / denom`（默认 `denom = 255`，可配置）。恒等式约束
  `0 <= c <= a <= denom`（预乘不变式），构造与更新时逐像素校验。
- **指定公式逐层半偶舍入**：source-over 合成
  `outA = srcA + dstA·(1 − srcA)`，`outC = srcC + dstC·(1 − srcA)`。
  整数域中每层的乘积 `dst·(denom − srcA)` 除以 `denom` 时按
  **round-half-to-even**（银行家舍入）取整，逐层生效。
- **透明像素不留残色**：所有入口（构造、矩形更新、混合输出）都会把
  `a = 0` 的像素规范化为 `{0,0,0,0}`；验证器对输出逐像素断言此性质。
- **矩形更新只改受影响输出，旧版本可读**（`src/compositor.ts`）：输出按
  16×16 tile 持久化存储，每次提交产生新版本；脏矩形只重写相交 tile
  （tile 内也只重算脏矩形覆盖的像素），未受影响的 tile 与上一版本
  **按引用共享**。所有历史版本可随时 `getPixel` / `readVersion` 读取。
  图层本身同样不可变（`Layer.withRect` 返回新图层）。
- **独立分数全层重算核对**（`src/verify.ts` + `src/fraction.ts`）：基于
  BigInt 的精确有理数管线（与整数管线不共享代码）对整层栈重算：
  逐层半偶舍入版本逐像素比对整数输出；无舍入精确版本给出累积舍入
  误差上界（≤ 层数 / (2·denom)）。同时统计通道极值（须在 `[0, denom]`
  内且颜色最大值 ≤ 透明度最大值）与交叠区域（覆盖率 ≥ 2 的像素）
  并单独核对。

## 目录结构

```
src/pixel.ts       整数分子像素、半偶舍入除法、source-over 混合、规范化
src/fraction.ts    BigInt 精确有理数与网格半偶舍入（独立实现）
src/layer.ts       不可变定位图层、矩形更新、像素校验与透明规范化
src/compositor.ts  图层栈合成、tile 化持久输出版本、脏矩形局部重算
src/verify.ts      分数全层重算、极值/交叠/残色/不变式核对
test/              node:test 测试（rounding / blend / update / verify）
types/node.d.ts    最小 node: 模块声明（离线环境无 @types/node）
```

## 运行测试

```
npm test    # tsc 编译后执行 node --test
```

## 实际测试结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test` 输出摘要：

```
ok 1 - dist/test/blend.test.js
ok 2 - dist/test/rounding.test.js
ok 3 - dist/test/update.test.js
ok 4 - dist/test/verify.test.js
# tests 4
# pass 4
# fail 0
```

逐文件直接运行的子测试明细（共 23 个，全部通过）：

```
blend.test.js    9/9  — 不透明覆盖、透明源恒等、半透明白叠黑(128/255)、
                        半偶(非半上)舍入实证、透明无残色、c<=a 不变式、
                        图层透明规范化、非法像素拒绝、withRect 不可变性
rounding.test.js 5/5  — 0.5/1.5/2.5/3.5/4.5 半偶舍入、最近邻舍入、
                        非法输入拒绝、Frac 约分与比较、BigInt 网格舍入
update.test.js   4/4  — 4×4 脏矩形仅重写 1/9 tile（8 块引用共享）、
                        旧版本(v0/v1/v2)更新后逐字节可读、跨界部分 tile
                        更新、画布外更新零输出变化
verify.test.js   5/5  — 3 组随机层栈(6 层, 24×24)分数重算零失配、
                        极值落于 [0,255] 且颜色峰值 ≤ 透明度峰值、
                        全透明/全白退化栈精确命中极值边界、三层交叠区
                        (16 像素覆盖率=3)分数一致、8 步随机矩形更新后
                        整数输出与分数重算持续同步
```
