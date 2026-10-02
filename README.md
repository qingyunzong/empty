# mvcc-event-store

单机离线设备事件存储：Node.js 22、仅标准库、`node:test` 测试。无第三方依赖、无网络访问。

## 数据模型

- `eventId` 标识业务事件；`validAt` 是事件实际发生时间（数值）；`txAt` 是入库事务时间（实现为单调递增的逻辑提交序号，每次写操作提交时 `++commitSeq`）。
- 事件可能乱序到达（`validAt` 与提交顺序无关），可见性只由 `txAt` 决定。
- 每个 `eventId` 对应一条**只追加的 MVCC 版本链**：插入、更正、删除都提交新版本，历史版本永不覆盖。
- **快照隔离**：`store.snapshot()` 记录 begin 时刻的 `commitSeq`，快照只读 `txAt <= beginTx` 的最新版本。
- **墓碑删除**：`delete` 追加 `deleted: true` 的墓碑版本；旧快照仍可见历史，新快照不可见。
- 删除后允许同名 `eventId` 重新 `insert`（作为链上的新版本）；未删除的重复创建抛 `E_DUP`。

## 索引

- `(eventId)` 主索引：`chains: Map<eventId, Version[]>`，链按 `txAt` 升序，快照读二分查找。
- `(deviceId, validAt)` 二级索引：`deviceIndex: Map<deviceId, IndexEntry[]>`，条目按 `(validAt, txAt)` 有序。每次提交追加索引日志：旧版本存活则追加 `live:false` 条目（索引迁移/删除标记），新版本非墓碑则追加 `live:true` 条目。`validAt` 或 `deviceId` 被更正时，旧键位自动标记失效、新键位生效，且带 `txAt`，因此各快照看到各自一致的索引视图。
- 范围查询 `range(deviceId, from, to)`：闭区间 `[from, to]`；`from > to`（空范围）返回 `[]`。对每个 `eventId` 取范围内 `txAt <= snapTx` 的最新索引条目（同一提交内 `live` 条目优先于失效标记），存活则回链取该快照可见版本。结果按 `(validAt, eventId)` 排序。

## API（`src/store.js`）

```js
import { MvccStore } from './src/store.js';

const store = new MvccStore();
store.insert({ eventId: 'A', deviceId: 'd1', validAt: 100, data: { state: 'alarm' } });
const snap = store.snapshot();          // 快照：begin 时刻已提交的最新版本
store.correct('A', { validAt: 500, data: { state: 'reset' } }); // 追加新版本，不改历史
store.delete('A');                      // 追加墓碑

snap.get('A');                          // 旧快照仍读到 alarm
snap.range('d1', 0, 1000);              // 旧快照范围查询仍包含
store.get('A');                         // 最新视图：null（已删除）
store.range('d1', 200, 100);            // 空范围：[]
```

错误：`StoreError`，`code` 为 `E_DUP`（重复创建）/ `E_NOENT`（不存在或已删除）/ `E_INVAL`（参数非法）。

## CLI（`cli.js`，JSON Lines over stdin/stdout）

每行一个 JSON 命令，每行输出一个 JSON 响应：

```sh
printf '%s\n' \
  '{"op":"insert","eventId":"A","deviceId":"d1","validAt":100,"data":{"state":"alarm"}}' \
  '{"op":"snapshot"}' \
  '{"op":"correct","eventId":"A","data":{"state":"reset"}}' \
  '{"op":"get","eventId":"A","snapshot":1}' \
  '{"op":"range","deviceId":"d1","from":0,"to":200}' | node cli.js
```

命令：`insert` / `correct` / `delete` / `snapshot`（返回 `{"snapshot":id,"txAt"}`）/ `get` / `range`（`get`、`range` 可带 `"snapshot":id`，缺省读最新提交视图）。

响应：`{"ok":true,"result":...}` 或 `{"ok":false,"error":{"code","message"}}`。

退出码：

- `0`：全部命令成功
- `1`：存在领域错误（`E_DUP` / `E_NOENT` / `E_INVAL`）
- `2`：用法错误（`E_PARSE` JSON 解析失败 / `E_USAGE` 未知命令 / 内部错误），优先级高于 1

## 测试

```sh
node --test
```

- `test/store.test.js`：验收场景 1（更正后旧快照读报警、新快照读复位、两个索引方向一致）、验收场景 2（墓碑删除后旧快照按 eventId 读历史、新快照范围排除、`E_DUP`）、索引迁移（`validAt`/`deviceId` 变更）、空范围、乱序到达、参数校验。
- `test/permutation.test.js`：对 3 组操作集（覆盖 ≤3 个事件的插入/更正/删除，含重复插入、删后重建、跨设备索引迁移）做全排列枚举（每组 5! = 120 种，共 360 种执行序列），逐步对照朴素参考实现 `oracle/refstore.js`（版本数组按 `txAt` 排序 + 快照过滤）的操作结果、错误码，以及每个提交点上的全部 `get`/`range` 快照读。
- `test/cli.test.js`：CLI 会话、退出码 0/1/2。

### 真实测试记录

环境：Node.js v22.22.1，Linux x86_64，2026-10-03。`node --test` 实际输出：

```
ok 1 - test/cli.test.js
ok 2 - test/permutation.test.js
ok 3 - test/store.test.js
# tests 3
# pass 3
# fail 0
```

逐文件子测试（共 16 个，全部通过）：

```
test/store.test.js       9/9 pass（验收 1、历史链、validAt/deviceId 索引迁移、验收 2、删后重建、空范围、乱序、E_INVAL）
test/permutation.test.js 3/3 pass（3 组 × 120 种排列对照朴素参考实现）
test/cli.test.js         4/4 pass（会话快照隔离、exit 1、exit 2、退出码优先级）
```

注：本开发沙箱会丢弃 node 子进程的管道数据，CLI 测试通过临时文件重定向 stdin/stdout；CLI 本身在常规 shell 管道下工作正常。
