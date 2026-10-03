# device-event-merger

设备开关事件归并库与 CLI。Node.js 22，仅使用标准库与 `node:test`，离线单机运行，不依赖系统时区。

## 模型

- **时区表**：`defineZone` 显式给出某厂区各段的 UTC 偏移及切换生效时刻（UTC）。本地时间戳按生效段换算为 UTC 毫秒；偏移回拨造成本地时间多解时取最新生效段，前跳造成本地时间不存在时报 `LOCAL_TIME_INVALID`。
- **事件**：设备产生 `ON`/`OFF` 事件，携带本地时间戳、时区与版本号。
- **归并**：同一设备的事件先按毫秒归并（同一毫秒同状态去重，同毫秒冲突取版本/序号最高者），再按周期窗口切分输出区间；相邻周期若落在同一维护静默区间且状态相同则合并为一个区间。
- **周期**：由起始点 `startUtc`、时长 `durationMs`、结束边界 `endUtc` 定义；`durationMs <= 0` 或 `endUtc <= startUtc` 报 `PERIOD_INVERTED`。
- **更正**：`replace`（替换）、`void`（作废）按事件 id 生成更高版本的记录；`merge` 带 `upToVersion` 可按版本重放任一历史视图。更正后的 `merge` 输出 `affectedRange`（与上一次同视图结果 diff 得到的受影响区间）与差异证书 `certificate`（每个区间列出被合并事件的原始 id 与时间线）。
- **开放区间**：缺少结束事件不是错误。末尾区间按观测截止点 `cutoffUtc` 生成并标记 `unclosed: true`（UNCLOSED）。

## 命令（JSON 行）

| cmd | 关键字段 | 说明 |
| --- | --- | --- |
| `defineZone` | `zone`, `offsets:[{effectiveFromUtc, offsetMinutes}]` | 定义时区偏移表；冲突报 `OFFSET_TABLE_CONFLICT` |
| `definePeriods` | `startUtc`, `durationMs`, `endUtc` | 定义周期窗口；倒错报 `PERIOD_INVERTED` |
| `defineSilence` | `startUtc`, `endUtc` | 定义维护静默区间 |
| `event` | `event:{id, deviceId, state, zone, localTime, version?}` | 上报事件；未知时区报 `UNKNOWN_ZONE` |
| `replace` | `id`, `event:{...}` | 迟到更正，替换同 id 事件（版本递增） |
| `void` | `id`, `version?` | 作废事件 |
| `merge` | `deviceId`, `observation:{startUtc, cutoffUtc}`, `upToVersion?` | 输出归并区间、受影响区间与差异证书 |

UTC 时刻可给 ISO 字符串或毫秒数；本地时间格式为 `YYYY-MM-DDTHH:mm:ss[.sss]`（不带偏移）。

## 使用

```sh
node src/cli.js commands.jsonl   # 或 stdin: node src/cli.js < commands.jsonl
```

每条输入命令输出一行 JSON；任一命令出错时进程退出码为 1。

```js
const { Engine, referenceMerged } = require('./src');
const engine = new Engine();
engine.execute({ cmd: 'defineZone', zone: 'plant-a', offsets: [/* ... */] });
const result = engine.execute({ cmd: 'merge', deviceId: 'dev-1', observation: { startUtc: 0, cutoffUtc: 60000 } });
```

## 测试

```sh
node --test
```

- `test/acceptance.test.js`：三条验收标准（偏移切换边界两侧、迟到更正改变三周期归并、非法偏移表与开放区间）。
- `test/reference.test.js`：边界扫描实现与逐毫秒枚举参考算法（`src/reference.js`）在随机场景（含替换/作废/版本重放）下逐区间对照。
- `test/cli.test.js`：CLI 命令行到 JSON 行的映射（沙箱禁止派生子进程，故在进程内调用 `runCommands` 入口测试）。
