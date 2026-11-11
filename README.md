# Hermite 曲线组件

面向动画宿主的可导入 TypeScript 曲线：每段为三次 Hermite 曲线，由端点时间、
值与一阶导数（切线）确定，端点时间严格递增。支持区间裁剪（C1 连续，不使用
采样折线）、区间外常量 / 循环 / 往返延伸，以及值与导数同时求值。

## 用法

```ts
import { HermiteCurve } from "./src/index.js";

const curve = new HermiteCurve(
  [
    { time: 0, value: 0, tangent: 1 },
    { time: 2, value: 3, tangent: -1 },
    { time: 5, value: 2, tangent: 0 },
  ],
  { pre: "cycle", post: "pingpong" }, // 默认两侧均为 "constant"
);

curve.sample(1.5);        // { value, derivative } 同时返回
curve.value(-10);         // 负时间按数学取模映射（cycle 模式）
curve.derivative(8);      // 往返反向段导数自动反号

const clipped = curve.trim(0.5, 4.5, { pre: "constant", post: "constant" });
clipped.trim(1, 3);       // 裁剪结果仍是 Curve，可继续组合裁剪

const point = curve.trim(2, 2); // 零长度裁剪：单点保留值与导数
point.sample(2);                // 该点原值与原导数
point.sample(2 + 1);            // 常量延伸，导数为 0
```

## 行为约定

- 裁剪点通过解析三次 Hermite 求值生成新端点，严格保持原值与一阶导数；
  原区间内部端点原样保留，拼接点 C1 连续。
- `constant`：区间外冻结边界值，导数为 0。
- `cycle`：周期为定义域长度，边界取右极限；负时间按数学取模映射。
- `pingpong`：往返周期为两倍定义域长度，反向段值镜像、导数反号。
- 零长度裁剪退化为单点曲线，仅在该点保留导数，其余位置常量延伸。
- 构造与求值均校验有限数值，端点时间必须严格递增。

## 构建与测试

```sh
npm run build   # tsc 类型检查并输出到 dist/
npm test        # 构建 + 14 项 node:test 用例（随机区间对照等）
```
