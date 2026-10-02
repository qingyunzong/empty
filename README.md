# device-event-merge

设备开关事件归并库与 CLI。Node.js 22,仅标准库 + `node:test`,离线单机运行,不依赖系统时区。

## 模型

- **时区表**(`defineZone`):每个厂区(zone)显式给出偏移规则 `{atUtc, offsetMinutes}`,
  规则在 UTC 时刻 `atUtc` 生效。本地时间按"最后一条本地生效时刻 <= 本地时间"的规则换算 UTC。
  同一生效瞬间重复、本地生效时刻非单调、偏移超出 [-12h, +14h]、空表均为 `OFFSET_TABLE_CONFLICT`;
  未定义厂区为 `UNKNOWN_TIMEZONE`。
- **归并**(`query` / `replay`):
  1. 毫秒级:同一设备同一 UTC 毫秒、同一状态的事件去重,原始 id 全部保留在 `ids` 中;
  2. 连续同状态事件折叠为状态区间,末尾无结束事件的区间延伸到观测截止点并标记 `UNCLOSED`
     (未决不视为不可满足);
  3. 周期窗口由 `{start, durationMs, end}` 定义(`durationMs <= 0` 或 `end <= start`
     为 `PERIOD_INVERSION`),区间在周期边界切分;
  4. 相邻周期若整体处于同一维护静默窗口且状态相同,则跨周期合并。
- **更正**(`correct`):`action: "replace" | "void"`,带单调 `version`。
  输出 `affected`(受影响区间)与 `certificate`:被合并事件的原始 id 列表、
  状态变化时间线、更正前后的归并区间。
- **重放**(`replay`):`toVersion` 只取版本 <= N 的记录重建区间。

## CLI

```
node bin/cli.js [commands.jsonl]   # 缺省读 stdin
```

每行一个 JSON 命令,每行输出一个 JSON 结果;单行错误输出
`{"ok":false,"type":"error","code":...}` 后继续处理后续行。

命令类型:`defineZone`、`event`、`correct`、`replay`、`query`。
事件时间用本地墙钟字符串(`YYYY-MM-DDTHH:mm:ss[.fff]`)+ `zone`;
观测窗口 `from`/`to` 为 UTC  epoch 毫秒。

示例见 `examples/session.jsonl`。

## 测试

```
node --test
```

`testing/reference.js` 是逐毫秒枚举状态的朴素参考算法,`test/merge.test.js`
用固定场景与 30 组随机事件与其对照;测试结果记录在 `TEST_RESULTS.md`。
