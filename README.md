# sensor-alert-replay

离线传感器 JSONL 重放与告警引擎。规则以 DSL 编写，经词法分析、Pratt 解析、
静态类型检查后编译为字节码，由增量 VM 在事件流上维护窗口与当前告警；
迟到的更正（`replaces`）与撤销（`retracts`）事件会触发按设备的时间线重算
与告警对账，使最终有效告警与朴素全量重放完全一致。仅使用 Node.js 22
标准库，全程单机离线。

## 快速开始

```sh
node src/cli.js run examples/rules.dsl examples/events.jsonl --out result.json
node --test
```

## 规则 DSL

```
field temp: C;                       # 声明字段及单位（C 温度 / A 电流）
field current: A;
group sensors = /^sensor-[0-9]+$/;   # 正则设备组
let temp_limit = 80C;                # 全局别名（词法作用域）

rule overtemp on sensors {           # 目标：all / 设备组名 / 设备ID / /正则/
  let hi = temp_limit;               # 规则内别名，遮蔽全局同名（词法作用域）
  alert critical when temp > hi for 5m;
}
```

- 词法模式覆盖：设备ID/标识符（`[A-Za-z_][A-Za-z0-9_-]*`）、温度/电流单位
  字面量（`80C`、`36.5C`、`10A`）、时长（`30s`、`5m`、`1h`）、正则设备组
  （`/^sensor-[0-9]+$/`）、`#` 注释。
- Pratt 解析优先级（低→高）：`or` < `and` < 前缀 `not` < 比较
  （`> >= < <= == !=`）< 后缀 `for`（仅可跟在比较后，如 `temp > 80C for 5m`）。
- 静态检查：字段必须声明；比较两侧单位必须一致（`temp > 80A` 报错）；
  告警级别必须是 `info` / `warning` / `critical`；`let` 别名遵循词法作用域
  （全局按序可见、规则内遮蔽全局、禁止前向引用）；正则设备组若匹配不到
  事件流中的任何设备则失败（空设备组）。
- 诊断信息带规则文件的行号与列号。

## 事件格式（JSONL，每行一个 JSON 对象）

```json
{"id":"e1","time":"2026-01-01T00:00:00Z","device":"sensor-1","type":"temp","value":85}
{"id":"e2","time":"2026-01-01T00:06:00Z","device":"sensor-1","type":"temp","value":70,"replaces":"e1"}
{"id":"e3","retracts":"e2"}
```

- `time` 为 ISO-8601 字符串或 epoch 毫秒；`type` 必须是已声明字段。
- 更正事件带 `replaces: <id>`，撤销事件带 `retracts: <id>`；引用未知或
  已失效的事件 id 属于领域错误（exit 2，错误写入结果 JSON，出错前已处理
  事件的记录仍然确定）。
- 事件可乱序、可重复：完全相同的重复事件（含重复更正/撤销）是幂等空操作；
  同 id 不同内容的数据事件按隐式更正处理。

## 语义

- 字段值在两次读数之间保持（last-value-carried）；从未上报的字段比较为假。
- `条件 for 时长`：条件须连续成立满时长才为真；到期的持续时间在其精确
  到期时刻触发，即使晚于最后一条事件（输入结束时统一 flush）。
- 同一时间戳：先应用该时刻全部事件再求值一次，再触发该时刻的到期。
- 增量 VM 对顺序事件走快速路径；乱序/更正/撤销按设备重算时间线，并与
  已发出的告警按开始时刻对账：未受影响的告警不重复触发，被改变的告警
  以 `withdraw`（`reason: corrected`）作废或修正，保证最终有效告警集合
  与朴素全量重放一致（`src/reference.js`，由随机一致性测试验证）。

## CLI

```
node src/cli.js run <rules.dsl> <events.jsonl> [--out result.json]
```

真实退出码（已验证）：

| 退出码 | 含义 |
|---|---|
| 0 | 成功，结果写入 `--out`（缺省输出到 stdout） |
| 1 | 用法错误或输入文件不可读 |
| 2 | 规则诊断（词法/解析/类型检查，含行列号）或事件领域错误（含事件序号） |

结果 JSON：`{ ok, records, errors, stats }`。`records` 为按序的
`alert` / `withdraw` 记录（含规则名、设备、级别、时间、原因）；
`errors` 中规则错误带 `line`/`col`，事件错误带 `event`（JSONL 行号）。

## 测试

```sh
node --test
```

最近一次真实运行结果：退出码 **0**，`# tests 6 / # pass 6 / # fail 0`
（本环境运行器按测试文件聚合计数；逐文件直接运行合计 **45 通过 / 0 失败**：

- `test/lexer.test.js` 7 通过
- `test/parser.test.js` 6 通过
- `test/checker.test.js` 9 通过
- `test/vm.test.js` 12 通过
- `test/consistency.test.js` 4 通过（含 40 个随机种子、≤200 条乱序/重复/
  更正/撤销事件与朴素全量重放的一致性对照）
- `test/cli.test.js` 7 通过（含退出码 0/1/2 与验收④的三类失败）

覆盖验收：①温度持续越限触发并在恢复后关闭；②迟到更正撤销旧告警且不重复
触发；③乱序、重复、≤200 条随机事件与朴素全量重放一致；④单位错误、
未声明字段、空设备组分别以 exit 2 失败。

## 结构

```
src/lexer.js      词法分析（设备ID、单位、时长、正则设备组）
src/parser.js     Pratt 解析器
src/checker.js    静态类型检查（字段/单位/告警级别/词法作用域）
src/compiler.js   别名展开 + 字节码编译
src/vm.js         增量 VM（窗口、HOLD 定时器、告警对账）
src/reference.js  朴素全量重放参考算法
src/engine.js     管线编排（规则→事件→结果 JSON）
src/cli.js        命令行入口
examples/         示例规则与事件
```
