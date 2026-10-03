# recipe-optimizer

化工厂原料配比优化器：从可审计的 DSL 出发，经词法分析、Pratt 解析、静态量纲
检查、宏展开，编译为字节码后在精确有理数 VM 上对整数克配比求值，求解最小总
成本配方，并输出带证书哈希的 JSON 计划。全程仅使用 Node.js 22 标准库，单机
离线运行。

## 快速开始

```sh
node src/cli.js optimize examples/feed.dsl --json plan.json
node src/cli.js verify plan.json
node --test
```

## 架构

```
DSL 源文本
  └─ src/lexer.js     词法层：g / kg / ppm / CNY、// 与 /* */ 注释、行列号
  └─ src/parser.js    声明文法 + Pratt 表达式解析；宏词法作用域、惰性展开、循环检测
  └─ src/sema.js      静态类型：量纲检查、属性维度约束、常量求值
  └─ src/compile.js   约束与目标编译为栈机字节码（常量折叠）
  └─ src/vm.js        精确有理数（BigInt 分数）栈机 VM
  └─ src/solve.js     整数克枚举 + 成本下界分支限界；确定性并列规则
  └─ src/plan.js      计划 JSON、规范序列化、SHA-256 证书、重优化验证
  └─ src/cli.js       optimize / verify 命令
```

所有数值（成本、含量、余量）一律使用 BigInt 精确有理数运算，不存在浮点误差，
因此"预算恰好等于最低成本"等边界行为是精确且可复现的。

## DSL 参考

```
// 注释（也支持 /* 块注释 */）
recipe "feed-mix";

macro min_protein = 200000 ppm;     // 宏：词法作用域，惰性展开，禁止循环
macro fat_cap = 60000 ppm;

ingredient corn {                   // 原料块；内部可定义局部宏（遮蔽外层）
  cost 3.2 CNY/kg;                  // 成本：货币/质量，复合单位即乘除表达式
  stock 10 kg;                      // 库存：质量
  allergen 1;                       // 过敏原系数：无量纲，仅用于并列规则
  protein 90000 ppm;                // 质量指标：无量纲分数（ppm = 1e-6）
}

total 1 kg;                         // 质量守恒：各原料克数之和（必填，唯一）
step 100 g;                         // 克步长（可选，默认 1 g）
budget 5 CNY;                       // 成本预算（可选）

constraint corn.protein * corn.grams + soy.protein * soy.grams
           >= min_protein * (corn.grams + soy.grams);

minimize corn.grams * corn.cost + soy.grams * soy.cost;
```

- 单位是乘性常量：`3.2 CNY/kg` 即 `(3.2 * CNY) / kg`，隐式单位结合优先级
  高于 `*` `/`，`+` `-` 最低，可用括号改变。
- 表达式由 Pratt 解析器处理：`+ - * /`、一元负号、括号、比较符
  `<= >= == < >`（仅用于 constraint）。
- 每个原料隐式拥有变量 `<name>.grams`（本次配比的克数，量纲为质量）。
- `cost`/`stock`/`allergen` 为保留属性，量纲分别固定为 货币/质量、质量、
  无量纲；其余属性为质量指标，必须是无量纲分数（用 ppm 声明）。

## 静态类型（量纲检查）

量纲为 `{mass, currency}` 指数映射。`g`/`kg` 是质量，`CNY` 是货币，`ppm`
与裸数是无量纲。加减与比较要求两边量纲一致，乘除按指数合并。例如
`1 kg + 5 ppm` 报错：

```
recipe.dsl:2:12: error: dimension mismatch: cannot add 'mass' and 'dimensionless' ('kg' vs 'ppm')
```

## 宏语义

- 宏体在使用点惰性展开，展开时在**定义处**的作用域中解析名字（词法作用域）；
  原料块内可定义局部宏，遮蔽外层同名宏。
- 同一作用域内宏相互可见，允许前向引用，因此循环可表达且必须报错：
  `macro x = y; macro y = x;` 在使用 `x` 处报
  `macro expansion cycle detected: x -> y -> x`。
- 同一作用域重复定义同名宏是错误。

## 求解与并列规则

求解器在 `step` 网格上枚举整数克配比（受 `total` 与 `stock` 约束），用 VM
对每条约束与目标求值，并以"剩余克数贪心填最便宜原料"的成本下界做分支限界。
比较键依次为：

1. 总成本较低者优；
2. 过敏原总量（`Σ allergen_i × grams_i`）较低者优；
3. 实际用到的原料名排序列表字典序较小者优；
4. 按原料名字典序排列的克数向量，首个不同处较小者优。

结果状态：

- `OPTIMAL`：存在可行解且最低成本 ≤ budget；
- `INFEASIBLE`：硬约束（库存、质量守恒、含量区间）无可行解；
- `OVER_BUDGET`：存在可行解但最低成本 > budget（输出中给出最低成本与预算，
  与 INFEASIBLE 严格区分）。

## CLI 与退出码（真实行为，经 test/cli.test.js 验证）

```
node src/cli.js optimize <recipe.dsl> [--json plan.json]
node src/cli.js verify <plan.json>
```

| 退出码 | 含义 |
|--------|------|
| 0 | 求得最优计划（已写出）/ 计划验证通过 |
| 1 | 领域结果：`INFEASIBLE`、`OVER_BUDGET`，或 verify 发现证书/最优性不符 |
| 2 | 诊断错误：词法、语法、量纲、宏循环、未声明原料、IO、JSON 格式错误；诊断信息含 `文件:行:列` |

`optimize` 成功时将计划 JSON 写入 `--json` 指定路径并同时打印到 stdout；
`INFEASIBLE`/`OVER_BUDGET` 时向 stdout 打印状态 JSON，不写计划文件。

## plan.json 与证书

计划包含：各原料克数、总成本、预算、过敏原总量、每条约束的左右值与余量
（`margin`，≥0 表示满足）、嵌入的 DSL 源文本，以及 `certificate`——对除证
书外全部字段做键序规范化 JSON 序列化后的 SHA-256。`verify` 重新计算证书，
并对嵌入源文本重新完整求解，确认记录的计划仍是最优解；任何篡改都会导致
退出码 1 并说明原因。

## 测试

```sh
node --test
```

最近一次运行（Node v22.22.1，本仓库提交）：**5 个测试文件，43 个子测试，
43 通过 / 0 失败**。

- `test/lexer.test.js`（5）：单位、货币、注释、行列号、词法错误。
- `test/parser.test.js`（6）：Pratt 优先级、括号、复合单位、隐式单位乘法。
- `test/sema.test.js`（12）：kg+ppm 混加报错、g/kg 相容、未声明原料/属性、
  宏循环、宏词法作用域、属性量纲约束。
- `test/solve.test.js`（9）：验收①与独立枚举参考实现（`support/reference.js`，
  不共享代码）在 4 种与 8 种原料下逐一比对最优成本与克数；验收②两组同成本
  方案的并列规则；验收③预算等于/低于最低成本边界；验收④库存不足为
  INFEASIBLE。
- `test/cli.test.js`（11）：optimize/verify 端到端、证书确定性、篡改检测、
  INFEASIBLE/OVER_BUDGET 输出、诊断行列号与退出码 0/1/2。

验收⑤（kg 与 ppm 混加、宏循环、未声明原料分别报错）由 sema 与 cli 两层
测试覆盖。

## 已知限制

- 枚举复杂度随 `total/step` 与原料数组合增长；请选择合适的 `step`
  （验收场景为 ≤8 种原料、≤20 g 步长）。
- 候选配比求值时若出现除以零（如某原料用量为 0 且出现在分母），该候选按
  不可行处理。
