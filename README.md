# qinspect

单机离线 Node.js 22 加工件质量检测库与 CLI。全部计算基于 BigInt 有理数精确算术，无第三方依赖。

## 模型

- 每个测点给 `x`、`y` 两个有理不确定区间 `[lo, hi]`。
- 校正为二次以内有理多项式 `c0 + c1*t + c2*t^2`（每轴一个），把测量区间映射到设计坐标。
  映射后的坐标盒精确计算：二次驻点 `-c1/(2*c2)` 恒为有理数，仅当它落在区间内时纳入候选，否则只取端点。
- 公差区为凸有理多边形（含边界）。非凸/退化返回 `E_GEOMETRY`。
- 判定：
  - `conforming`：整个坐标盒（含边界）在多边形内，恰接触边也算 conforming；
  - `nonconforming`：盒与多边形完全无公共点；
  - `uncertain`：其余情况（跨越或从外侧接触边界）。
- 显示坐标按 `precision` 指定的小数位四舍五入（half away from zero），同时输出精确坐标范围
  （`p/q` 字符串）与舍入误差界 `1/(2*10^precision)`。
- 分母为 0 返回 `E_RATIONAL`；非法区间（lo > hi）返回 `E_INTERVAL` 并回滚事务；
  非法/未知校正返回 `E_CORRECTION`，失败校正不改变已记录判定。
- 增量 `addPoint`、`defineCorrection`/`useCorrection` 更换校正版本（自动重判全部测点），
  支持 `undo`/`redo`。

## CLI

stdin 一个 JSON，stdout 单行 JSON。顶层失败退出码 1，操作级错误逐条返回且退出码 0。

```sh
echo '{"tolerance":{"polygon":[["0","0"],["10","0"],["10","10"],["0","10"]]},
       "precision":3,
       "operations":[{"op":"addPoint","id":"a","x":["1/3","2"],"y":["1","2"]},
                     {"op":"judge","id":"a"}]}' | node src/cli.js
```

操作：`defineCorrection{version,x,y}`、`useCorrection{version}`、`addPoint{id,x,y}`、
`judge{id}`、`analyze{id}`（盒四角与边界关系枚举）、`undo`、`redo`。
有理数可写 `"p/q"`、整数或十进制小数字符串。

## 库

```js
import { Inspector } from './src/inspector.js';
const insp = new Inspector({ polygon, precision: 3 });
insp.addPoint('a', ['1/3', '2'], ['1', '2']);
insp.getJudgment('a'); // { status, box: { x/y: { exact, display } }, rounding }
```

## 测试

```sh
node --test
```
