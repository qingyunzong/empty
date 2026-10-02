# riskdsl — 支付风控规则 DSL

商户 / 渠道 / 全局三级文本规则：词法支持 IP 段（CIDR）、商户号、金额区间、正则白名单；
Pratt 解析 `and` / `or` / `not` / `in`；静态类型区分 `cidr` / `money` / `count`；
词法作用域保证外层 deny 优先、内层只能收紧不能放宽（显式 `override` 除外且留痕）；
规则编译为字节码，由 VM 对事件流判定 `ALLOW` / `REVIEW` / `DENY`。
历史判定可按事件时间匹配规则版本重放。仅依赖 Node.js 标准库（Node 22，`node:test`）。

## 运行

```bash
node --test                                        # 全部测试
node bin/risk.js check examples/rules.rsk          # 仅编译/静态检查
node bin/risk.js eval examples/rules.rsk examples/events.jsonl --explain
node bin/risk.js eval examples/rules.rsk examples/rules-v2.rsk examples/events.jsonl
```

`eval` 接受多个规则文件（热更新），每个事件一行 JSON 输出；`--explain` 附加命中轨迹与
override 留痕；`--version N` 可钉住某个规则版本。出错时退出码为 2，stderr 打印 `E_*` 错误。

## DSL 语法

```
version 1
valid_from 2026-01-01T00:00:00Z        # 可选；版本生效时间，用于回放匹配

rule g_base level global {
  deny when amount > 10000CNY
  review when count > 10
}

rule c_payx level channel match channel payx {
  deny when amount > 8000CNY           # 收紧外层阈值，无需 override
  review when not ip in 10.0.0.0/8
}

rule m_vip level merchant match merchant M1001 {
  override deny when amount > 12000CNY # 放宽外层阈值：必须显式 override，且写入留痕日志
  allow when merchant in /M10\d+/
}
```

- 字段类型：`ip: cidr`、`amount: money`、`count: count`、`merchant/channel/tag: string`。
- 字面量：金额必须带币种后缀（`100CNY`、`99.5USD`）；计数为整数；区间为 `a..b`；
  列表为 `[M1, "M2"]`；正则白名单为 `/.../`（整串锚定匹配）。
- 表达式：`and` / `or` / `not` / 括号 / 比较（`> >= < <= == !=`）/ `in`。
  优先级：`not` > 比较、`in` > `and` > `or`。
- 层级：`global` < `channel`（`match channel <id>`）< `merchant`（`match merchant <id>`）。
  一个文件可含多个 `version` 块；`valid_from` 必须递增。

## 判定语义

- 适用规则 = 全局规则 + 命中 `match` 的本渠道 / 本商户规则。
- 最终决策取所有命中语句中最严者：`DENY > REVIEW > ALLOW`（外层 deny 天然优先，
  内层 allow 无法放行外层 deny）。无命中默认 `ALLOW`。
- 同一事件命中多条并列最严规则时全部列入 `matched`，按（层级, 规则名, 语句序号）稳定排序。
- `REVIEW` 且事件 `review` 字段为 `pending` / 缺失时，结果保持 `review`（未决复核不视为通过）；
  `approved` → `allow`，`rejected` → `deny`。
- 金额比较要求币种一致，否则该语句不触发。

## 作用域与 override

编译期对"简单阈值语句"（顶层 `字段 比较符 字面量`）做收紧性检查：内层规则相对任一外层的
同决策、同字段、同方向阈值——

- deny / review：触发集合变小（如 `> 10000` 改成 `> 12000`）属于放宽；
- allow：触发集合变大（如 `< 1000` 改成 `< 2000`）属于放宽。

放宽必须写 `override`，否则报 `E_OVERRIDE`；写了则编译通过并记入规则集的
`overrideLog`（含内外层规则名与阈值），`--explain` 输出中可见。

## 版本与回放

`RuleStore` 按 `valid_from` 保存所有版本；事件按 `ts` 匹配"生效时间不超过事件时间的最新
版本"，因此热更新后旧事件重放仍走旧版本。`--version N` 可强制指定版本。

## 错误码

- `E_OVERRIDE`：内层放宽外层阈值且未显式 `override`。
- `E_TYPE`：静态类型错误（如 `amount > 5`、`ip in 100..200`、未知字段）。
- `E_CIDR`：非法 CIDR（坏地址、前缀越界、主机位非零）。
- `E_VERSION`：版本重复、`valid_from` 未递增、事件时间无任何版本覆盖、指定版本不存在。
- `E_PARSE`：词法 / 语法错误。

## 结构

- `src/lexer.js` 词法（CIDR / 金额 / 正则 / 区间 / 时间戳）
- `src/parser.js` Pratt 解析（`and/or/not/in`）
- `src/typecheck.js` 静态类型（cidr/money/count/string）
- `src/compiler.js` 字节码编译 + 作用域 override 检查与留痕
- `src/vm.js` 栈式字节码 VM
- `src/evaluate.js` 决策聚合（最严优先、并列稳定排序、复核未决不放过）
- `src/store.js` 版本化存储与按事件时间回放
- `bin/risk.js` CLI（`check` / `eval --explain`）
- `test/reference.js` 独立 AST 决策树参考实现，供模糊对照
- `test/fuzzgen.js` 带种子的随机规则 / 事件生成器
