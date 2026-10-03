# kvx — 离线可合并的事务 KV 存储与可串行化判定

多家实验室各自离线维护证据数据库副本，定期导出 WAL 日志段互相合并。
本库判定合并后的全局历史是否等价于某个串行执行（冲突可串行化判定 +
重放验证）。Node.js 22，仅标准库，测试用 `node:test`。

## 结构

- `src/clock.js` — 向量时钟（tick / merge / 偏序比较）
- `src/wal.js` — WAL 段编解码：JSONL，每条记录带 SHA-256 校验和
- `src/store.js` — 本地事务存储：commit / 读 / 快照读 / export / import / 崩溃恢复
- `src/history.js` — 合并器：因果序、依赖图、环检测、拓扑序、重放验证
- `src/brute.js` — 参考判定器：暴力枚举所有串行排列（仅供小规模测试对照）
- `bin/kvx.js` — CLI

## 数据模型

事务提交为一条 WAL 记录：

```json
{"id":"A:2","node":"A","seq":2,"clock":{"A":2},"reads":{"x":"1","y":null},"writes":{"y":"2"}}
```

- `reads` 记录事务读到的前像（`null` = 键不存在）；读在写之前生效（不实现 read-your-own-write）。
- `clock` 是提交时的向量时钟；导入外部记录时本地时钟取分量最大值合并。
- 合并序（merged order）= 向量时钟偏序的拓扑序，并发事务按事务 id 字典序决胜，各副本结果确定且一致。

## 可串行化判定

1. 以合并序构建依赖图：
   - **ww**：同一键的写者按合并序链式相连；
   - **wr**：读者依赖其记录值对应的写者（reads-from）；
   - **rw**：读者必须排在该键所有更晚写者之前（反依赖）；
   - 读到无人写过的值 → 自环（不可满足）。
2. 有环 → `NON_SERIALIZABLE`，返回一个具体冲突环（如 `A:1 -> B:1 -> A:1`）。
3. 无环 → 拓扑序即等价串行历史；按该序重放，逐条校验记录读值，
   且最终状态必须与合并状态一致，否则报 `NON_SERIALIZABLE`（`replay-mismatch`）。

已知边界：当同一键被写入**相同值**多次时，reads-from 不唯一，判定取
「合并序中最后一个匹配写者」的启发式，理论上可能误报；每键写值唯一
（本库正常产生的历史均满足）且每键写者数 ≤ 2 时，所有依赖边都是必要
约束，图判定与暴力枚举严格等价（随机对照测试覆盖，见下）。

## 错误约定

- 日志段损坏（JSON 不合法 / 校验和不匹配）：`import` 返回 `CORRUPT`，
  跳过坏行、导入其余合法记录；打开数据库时遇到撕裂写（如崩溃残留）
  同样跳过并计入 `store.corrupt`。
- 重复导入幂等：按事务 id 去重，报告 `duplicates` 计数。
- CLI 退出码：`0` 成功 / `1` NON_SERIALIZABLE / `2` 用法错误。

## CLI

```sh
kvx commit --db DIR --node A [--read k]... [--write k=v]...   # 提交事务，打印 WAL 记录
kvx read   --db DIR --key k [--at '{"A":1}']                  # 读 / 向量时钟快照读
kvx export --db DIR [--since N] [--out FILE]                  # 导出日志段（--since 仅本地增量）
kvx import --db DIR --file SEGMENT                            # 合并外部日志段
kvx check  --db DIR                                           # SERIALIZABLE + 拓扑序，或 NON_SERIALIZABLE + 冲突环
kvx replay --db DIR                                           # 按等价串行序重放并校验最终状态
```

示例（两个离线副本合并）：

```sh
kvx commit --db labA --node A --write alice=100
kvx commit --db labB --node B --write bob=50
kvx export --db labA --out a.log && kvx export --db labB --out b.log
kvx import --db labA --file b.log && kvx import --db labB --file a.log
kvx check --db labA    # SERIALIZABLE, order: A:1 -> B:1
kvx replay --db labA   # REPLAY OK, state {"alice":"100","bob":"50"}
```

## 崩溃恢复与快照

WAL 是唯一事实源：每次 `open()` 重放全部记录重建内存状态与每键版本链，
因此进程崩溃后重开即恢复；快照读通过版本链按向量时钟定位可见版本。

## 测试（真实结果）

`node --test`，Node v22.22.1，本仓库最近一次运行输出：

```
# tests 5
# pass 5
# fail 0
random cross-check: 300 cases, serializable=224, non-serializable=76, all verdicts match brute force
```

覆盖三个验收场景：

1. `test/merge.test.js` — 两个无冲突副本双向合并后 `check` 通过、状态
   正确且两副本给出相同等价串行序；
2. `test/merge.test.js` — 交叉读写同一键（A 读 y 写 x，B 读 x 写 y）合并后
   `check` 报 `NON_SERIALIZABLE`，环中事务均真实存在于合并历史；
3. `test/random.test.js` — 固定种子随机生成 300 个可串行/不可串行混合
   历史（≤7 事务、2–3 副本），图判定与暴力枚举全部串行排列的参考判定器
   逐一比对，300/300 结论一致。

另有 `test/store.test.js`（WAL 记录、崩溃恢复、撕裂写跳过、快照读、
幂等导入、损坏段跳过）与 `test/cli.test.js`（CLI 端到端、冲突退出码、
CORRUPT 报告）。
