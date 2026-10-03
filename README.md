# qinspect — 加工件质量检测库与 CLI

单机离线、零依赖（Node.js >= 22，仅用内置模块）。所有计算基于 BigInt 精确有理数，无浮点误差。

## 模型

- **测点**：`x`、`y` 各为一个有理不确定区间 `[lo, hi]`（`lo <= hi`，标量视为退化区间）。
- **校正映射**：逐坐标的一元有理多项式，次数 <= 2，升幂系数 `[c0, c1, c2]`：
  `X = c0 + c1*x + c2*x^2`，`Y = d0 + d1*y + d2*y^2`。
  映射后的坐标盒精确取端点值；二次驻点 `t* = -c1/(2*c2)` 必为有理数，
  仅当 `t* ∈ [lo, hi]` 时纳入候选（`src/polynomial.js`）。
- **公差区**：凸有理多边形（顶点有序，允许共线边，至少 3 顶点）。
  非凸或退化（全共线）→ `E_GEOMETRY`。
- **判定**（`src/geometry.js`）：
  - `conforming`：坐标盒四角全部在多边形内或边界上（盒 ⊆ 多边形，含边界）。
  - `nonconforming`：盒与多边形不相交（分离轴：多边形边法线 + x/y 轴）。
  - `uncertain`：其余情况（盒跨越边界；从外侧仅接触边界也算 uncertain）。
- **显示**：坐标按指定小数位四舍五入（half away from zero），并附精确有理
  范围与舍入误差界 `1/(2*10^k)`。

## 错误码

| 代码 | 含义 |
|---|---|
| `E_RATIONAL` | 分母为 0、除以 0、有理数无法解析 |
| `E_GEOMETRY` | 公差多边形非凸 / 退化 / 顶点不足 |
| `E_INTERVAL` | 区间下界大于上界 |
| `E_VALIDATION` | 其他输入校验失败（未知 op、重复 id 等） |
| `E_PARSE` | stdin 不是合法 JSON |

## CLI

`node src/cli.js`：stdin 读入 JSON（单条命令对象、命令数组，或
`{"commands": [...]}`），stdout 输出**单行** JSON。全部成功退出码 0；
任一命令失败则中止批处理，输出 `{ok:false, results:[已完成], error}`，退出码 1。

### 命令

- `{op:"setTolerance", polygon:[[x,y],...]}`
- `{op:"setCorrection", version:"v2", x:[c0,c1,c2], y:[d0,d1,d2]}`（省略某轴则为恒等）
- `{op:"addPoint", id:"p1", x:[lo,hi], y:[lo,hi], decimals?}`
- `{op:"undo"}` / `{op:"redo"}`
- `{op:"getState", decimals?}`（默认 3 位小数）

有理数可写为整数、小数字符串（`"0.125"`）、分数（`"-3/4"`）或 `{num, den}`。

### 示例

```sh
echo '{"commands":[
  {"op":"setTolerance","polygon":[[0,0],[1,0],[1,1],[0,1]]},
  {"op":"addPoint","id":"p","x":["1/2","3/2"],"y":["1/2","1/2"]},
  {"op":"setCorrection","version":"quad","x":["3","-2","1"],"y":["0","1"]},
  {"op":"getState","decimals":2}
]}' | node src/cli.js
```

## 事务与 undo/redo

所有变更先完整校验再提交；失败时恢复快照，已记录判定不变（非法区间、
零分母、非凸多边形、非法校正均回滚）。undo/redo 基于快照栈，新变更清空 redo 栈。

## 测试

```sh
node --test
```

`test/` 覆盖四条验收标准：n<=6 多边形四角枚举与边界关系、盒恰触一边判
conforming、二次顶点使测点 uncertain→nonconforming、非法区间事务回滚，
以及有理数/舍入、E_GEOMETRY、E_RATIONAL、CLI 单行输出与退出码。
