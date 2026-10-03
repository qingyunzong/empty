# sentinel-replay

离线传感器 JSONL 重放与增量告警。规则以 DSL 编写，经词法分析、Pratt 解析、
静态类型检查后编译为字节码，由增量 VM 维护每个设备的窗口与当前告警集合；
迟到更正（`replaces`）与撤销（`retracts`）到达时产生 `alert`/`withdraw`
记录，最终结果与朴素全量重放参考算法一致。仅使用 Node.js 22 标准库，单机离线。

## 使用

```sh
node src/cli.js run rules.dsl events.jsonl --out result.json
```

省略 `--out` 时结果写到 stdout。示例见 `examples/`。

## 规则 DSL

```
# 注释
let limit = 80C                      # let 别名（词法作用域：顺序生效，后者遮蔽前者）

alert overheat level critical        # 级别：info | warning | critical
  on devices(/^dev-/, dev-9)         # 设备组：设备ID 与正则混排，空组为静态错误
  when temp > limit for 5m           # 条件持续 5m 才触发；支持 and / or / not 与括号
```

- 词法模式：设备ID（`dev-1`）、温度/电流单位（`80C`、`3.5A`）、时长（`30s`、`5m`、`2h`）、正则设备组（`/^dev-\d+$/`）。
- 内置字段：`temp`（单位 `C`）、`current`（单位 `A`）。单位不匹配（如 `temp > 80A`）、
  未声明字段、空设备组、未知告警级别均为静态错误，诊断含规则行号与列号。
- 优先级：`not` > 比较 > `and` > `or`；`for` 直接绑定其左侧比较式。

## 事件格式（JSONL，可乱序）

```json
{"id":"e1","time":0,"device":"dev-1","type":"temp","value":85}
{"id":"e2","time":60000,"device":"dev-1","type":"temp","value":70,"replaces":"e1"}
{"id":"r1","retracts":"e2"}
```

- `time` 为毫秒数或 ISO 8601 字符串；`type` 对应规则字段（`temp`/`current`）。
- 更正事件用 `replaces` 指定被替换的事件 id；撤销事件用 `retracts`。
- 幂等：重复送达（同 id）、对已删除 id 的重复更正/撤销均为无操作。
- 未知事件 id（`replaces`/`retracts` 指向从未见过的 id）属于领域错误：
  该记录无效、不产生影响，错误写入结果 JSON 的 `errors`（含事件序号），
  已处理事件的结果保持确定。

## 语义

- 条件为随事件时间变化的阶跃函数；`for D` 要求条件连续为真满 `D` 才触发。
- 每条输入记录后，增量 VM 仅重评估受影响设备的窗口，与之前告警集合做差分，
  发出 `alert`/`withdraw` 记录（`reason`：`recovered`/`corrected`/`retracted`）。
- 不变式：折叠增量记录流得到的当前告警集合 == 对同一最终事件集做朴素全量
  重放得到的告警集合（`test/consistency.test.js` 以 ≤200 条随机乱序/重复/
  更正/撤销事件验证）。

## 退出码

| 码 | 含义 |
|----|------|
| 0 | 成功，结果 JSON 已写出 |
| 1 | 用法错误或文件不可读（不写结果文件） |
| 2 | 诊断错误：DSL 错误（stderr 含 `行:列`）或事件/领域错误（结果 JSON 仍写出，`errors` 含事件序号） |

## 测试

```sh
node --test
```

最近一次运行：**6 个测试文件全部通过，39 项测试 pass / 0 fail**
（lexer 6、parser 5、checker 7、engine 7、consistency 9、cli 5）。

覆盖验收项：
1. 温度持续越限触发并在恢复后关闭（`test/engine.test.js`）。
2. 迟到更正撤销旧告警且不重复触发；重复更正幂等（`test/engine.test.js`）。
3. 乱序、重复、≤200 条随机事件与朴素全量重放一致（`test/consistency.test.js`，8 个种子）。
4. 单位错误、未声明字段、空设备组分别失败（`test/checker.test.js`）。

## 结构

- `src/lexer.js` — 词法器（设备ID/单位/时长/正则，行列跟踪）
- `src/parser.js` — Pratt 解析器（`for`/`and`/`or`/`not`/`let`/`alert`）
- `src/checker.js` — 静态检查（字段、单位、级别、词法作用域、空设备组）
- `src/compiler.js` — 编译为栈机字节码（`CONST/LOAD/CMP/AND/OR/NOT/HOLD`）
- `src/vm.js` — 增量 VM：区间序列求值、窗口与告警提取
- `src/store.js` — 事件存储：乱序/更正/撤销/幂等的共享语义
- `src/engine.js` — 增量引擎：受影响设备重评估 + 告警差分
- `src/replay.js` — 朴素全量重放参考算法
- `src/cli.js` — `run` 子命令、诊断与退出码
