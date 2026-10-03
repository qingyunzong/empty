# riskdsl — 支付风控规则 DSL

单机离线、零依赖（仅 Node.js 22 标准库）的风控规则引擎：文本规则 → 词法/语法分析 →
静态类型检查 + 词法作用域校验 → 字节码 → 栈式 VM 对事件流判定 `ALLOW` / `REVIEW` / `DENY`。

## 快速开始

```bash
node --test                                          # 运行全部测试
node bin/risk.js check examples/rules.rsk            # 编译检查，打印版本与 override 留痕
node bin/risk.js eval examples/rules.rsk examples/events.jsonl
node bin/risk.js eval examples/rules.rsk examples/events.jsonl --explain
```

`eval` 默认每个事件输出一行 JSON（`decision` + 并列最严规则列表）；`--explain`
输出人类可读的命中轨迹、并列最严规则与 override 留痕。出错时 stderr 打印
`E_XXX: message` 并以退出码 2 退出。

## DSL 概览

```rsk
version "v1" since "2024-01-01T00:00:00Z" {
  scope global {
    threshold max_amount: money = 10000.00;     // money（分）/ count（整数）/ cidr
    threshold max_count: count = 100;
    whitelist vip = /^VIP[0-9]{4}$/;            // 正则白名单

    rule g_amount {
      when event.amount > max_amount then deny  // allow | review | deny
    }

    scope channel("alipay") {
      override threshold max_amount: money = 5000.00;   // 显式 override，只能收紧
      rule a_band {
        when event.amount in 3000.00..5000.00 and not (event.merchant in vip) then review
      }
      scope merchant("MCH000001") {
        override threshold max_amount: money = 2000.00;
        rule m_amount { when event.amount > max_amount then deny }
      }
    }
  }
}
```

- **词法**：CIDR（`10.0.0.0/8`）、IP 字面量、商户号等字符串、金额/数量区间
  （`100.00..500.00`、`1..10`）、正则白名单（`/^MCH[0-9]{6}$/`）、`//` 与 `#` 注释。
- **表达式**：Pratt 解析 `or` < `and` < `not` < 比较/`in`，支持括号。
  `in` 支持 `ip in cidr`、`string in regex`、`money/count in 区间`。
- **事件字段**（静态类型）：`amount: money`、`count: count`、`ip: ip`、
  `merchant/channel/id/time: string`。金额内部以“分”整数表示，无浮点误差。
- **作用域**：`global` / `channel("...")` / `merchant("...")` 词法嵌套；规则只在
  事件匹配整条作用域链时生效。内层引用阈值时按词法就近解析——外层 deny 阈值
  永远生效，内层无法绕过。

## override 语义（防误放行核心）

- 内层声明同名阈值属于**遮蔽**，必须写 `override`，否则 `E_OVERRIDE`。
- 带 `override` 也只能**收紧**：money/count 要求内层值 ≤ 外层值；cidr 要求内层是
  外层的子网。放宽（无论是否写 `override`）都是 `E_OVERRIDE`。
- 每次合法 override 都会**留痕**（版本、作用域、内外值），见 `risk check` 与
  `--explain` 的 `overrides:` 段。

## 判定语义

- 决策严格度：`DENY > REVIEW > ALLOW`，聚合取最严；无规则命中默认 `ALLOW`。
- **未决人工复核不视为通过**：只要命中 `review` 且无 `deny`，结果就是 `REVIEW`。
- 同一事件命中多条**并列最严**规则时全部列出，按 `作用域路径/规则名` 字典序
  稳定排序（与规则在源码中的书写顺序无关）。

## 版本与重放

- 一个 `.rsk` 文件可含多个 `version "..." since "..."` 块；`Engine.loadSource`
  可多次调用实现**热更新**（重复版本号或相同生效时间报 `E_VERSION`）。
- 每个事件按 `event.time` 路由到 `since <= time` 的最新版本：热更新后，历史事件
  重放仍按旧版本判定，结果与更新前完全一致（见 `test/replay.test.js`）。

## 事件格式（JSONL）

```json
{"id":"e1","time":"2024-03-01T10:00:00Z","merchant":"MCH000001","channel":"alipay","ip":"10.1.2.3","amount":12000.00,"count":3}
```

## 错误码

| 代码 | 含义 |
| --- | --- |
| `E_OVERRIDE` | 未声明 `override` 的同名遮蔽、override 放宽外层阈值、无外层可 override、同作用域重复声明 |
| `E_TYPE` | 静态类型错误（money/count 混用、非布尔逻辑运算、未知字段/名字、非法字面量等） |
| `E_CIDR` | 非法 CIDR/IP（八位组 >255、前缀 >/32、事件 IP 非法等） |
| `E_VERSION` | 版本号重复、生效时间相同/非法、事件时间无任何版本覆盖 |
| `E_LEX` / `E_PARSE` / `E_EVENT` | 词法、语法、事件 JSON 行错误（辅助码） |

## 结构

```
src/lexer.js     词法分析（CIDR/IP/区间/正则字面量）
src/parser.js    Pratt 解析（and/or/not/in/比较）
src/checker.js   静态类型 + 词法作用域 + override 收紧校验（留痕）
src/compiler.js  编译为栈式字节码
src/vm.js        字节码 VM
src/engine.js    版本路由、事件归一化、判定聚合、explain
bin/risk.js      CLI（check / eval [--explain]）
test/            node:test 测试（含独立决策树参考实现的随机对照）
```
