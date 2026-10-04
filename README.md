# recall-trace

产品召回追溯库与 CLI。Node.js 22，仅标准库与 `node:test`，离线单机执行。

## 运行

```sh
node --test          # 运行全部测试，真实结果写入 test-results.txt
node cli.js < input.json > output.json   # 或 node cli.js input.json
```

任一 op 出错时 CLI 退出码为 1，输入非法时为 2；输出始终为 JSON。

## 输入模型

输入为 `{ "ops": [...] }`（或裸数组），按序执行：

- `addBatch`：`{op, id, localStart, localEnd, shelfLifeMs, packagingMs, conversion}`
  - `localStart/localEnd`：工厂本地时刻（ISO 8601，不带时区）。
  - `shelfLifeMs/packagingMs`：保质期 / 包装封存周期（毫秒，非负）。
  - `conversion`：转换表 `[{local, utc}]`，把本地时刻映射为 UTC；取不大于目标时刻的最近锚点的偏移（阶跃式，类似时区切换）。
  - 有效期窗口 = `[生产结束UTC, 生产结束UTC + shelfLifeMs)`；封存窗口同理以生产结束时刻起算。
- `addRecord`：`{op, id, parent, child}`——批次消耗谱系记录（parent 被消耗产出 child，支持多父合流）。
- `correctRecord`：`{op, id, parent, child}`——更正记录，产生新版本；旧快照仍指向旧版本，不受影响。
- `snapshot`：`{op, name}`——命名快照，固化当前各记录版本。
- `rollback`：`{op, name}`——把当前状态回滚到命名快照（快照本身保留，新旧结果并存）。
- `recall`：`{op, defect, observeStart, observeEnd, snapshot?}`——沿谱系从缺陷组件批次前向追溯所有谱系路径，对终端成品批次判定观测区间（UTC）内是否仍在有效期、是否处于封存周期。

## 输出

每个 `recall` op 产出 `results`，每条结果对应一条谱系路径：

- `product`：受影响成品批次；`hitInterval`：命中输入观测区间的部分（左闭右开）。
- `inShelfLife` / `shelfLifeWindow`、`inPackaging` / `packagingHitInterval`。
- `path`：路径证书，`[{record, version, parent, child}, ...]`。

区间集合（`src/intervals.js`）支持并、交、差，左闭右开；仅端点接触的交集为空，不算受影响。观测区间与有效期窗口有正长度交集才判定命中。

## 错误码

`UNKNOWN_SNAPSHOT`（快照未知）、`REVERSED_INTERVAL`（区间反转）、`NEGATIVE_SHELF_LIFE`（保质期为负），另有 `NEGATIVE_PACKAGING`、`UNKNOWN_BATCH`、`UNKNOWN_RECORD`、`DUPLICATE_RECORD`、`INVALID_TIME`、`EMPTY_CONVERSION`、`UNKNOWN_OP`。

## 结构

- `src/intervals.js` 半开区间集合；`src/timeutil.js` 时间解析与转换表
- `src/store.js` 批次、版本化谱系记录、命名快照与回滚
- `src/recall.js` 主追溯算法 + 枚举全部谱系路径的参考算法（测试交叉校验）
- `src/engine.js` op 执行器；`cli.js` 命令行入口
- `test/recall.test.js` 验收测试；`test-results.txt` 真实结果
