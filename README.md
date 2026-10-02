# devlog — 本地设备日志库与 DSL 查询引擎

Node.js 22，仅使用标准库，单机离线。JSONL 设备日志（字段 `ts`、`device`、`code`、`value`）的
追加写存储、WAL/segment/manifest 容错、故障恢复，以及编译为字节码执行的查询 DSL。

## 快速开始

```bash
node src/cli.js append log.jsonl --db ./db     # 追加 JSONL 日志
node src/cli.js query q.dsl --db ./db          # 执行 DSL 查询
node src/cli.js recover --db ./db              # 故障恢复
node --test                                    # 运行测试
```

`append` 输入每行一个 JSON 对象：`ts`（epoch 毫秒或 ISO 时间串）、`device`（非空字符串）、
`code`（字符串）、`value`（有限数值）。写入时分配单调递增的 `seq`。

## 查询 DSL

```
let hot = value > 1.5k
let pump = device matches "pump-*"
select count(), avg(value) where pump and hot and ts >= 2026-10-01T08:00:00Z
```

- **词法层**
  - 时间字面量：`2026-10-01`、`2026-10-01T08:00:00Z`、`2026-10-01T08:00:00+08:00`（缺省按 UTC）。
  - 数字单位：`k/M/G`、`KB/MB/GB`（十进制）、`KiB/MiB/GiB`（二进制）、`ms/s/m/h/d`（时长，换算为毫秒）。
  - 设备模式：字符串 glob，`*` 匹配任意序列，`?` 匹配单字符，配合 `matches` 运算符。
  - `#` 行注释。
- **语法（Pratt 解析）**：优先级 `or` < `and` < 比较（`== != < <= > >= matches`）< `not`；
  括号可显式分组。
- **静态模式检查**：字段类型固定为 `ts: time`、`device: string`、`code: string`、`value: number`。
  未知字段、类型不匹配（如 `ts > 5`、`value == "x"`）、`matches` 右操作数非字符串模式等
  均在执行前报静态错误。
- **let 子查询**：`let 名 = 表达式` 顺序绑定、词法作用域，后面的 let 与 where/select 可引用
  前面的绑定，同名绑定遮蔽前者。
- **聚合**：`select count(), sum(value), avg(value), min(value), max(value) where ...`；
  无 `select` 时输出匹配记录，按 `(ts, device, seq)` 排序（乱序写入也按此序输出）。

## 编译与执行

查询先经 词法分析 → Pratt 解析 → 静态类型检查，再编译为栈式字节码（`push/load_field/
load_slot/cmp/matches/not/jmp_false/jmp_true`），`and/or` 用跳转实现短路；let 绑定编译为
按序求值的 slot 程序。执行时从 where 表达式的顶层合取中提取 `ts` 常量界，用 segment 时间
索引做裁剪（跳过 `[minTs, maxTs]` 与查询区间不相交的 segment），命中记录仍逐条求值完整
谓词，因此结果与全量扫描严格一致（`test/fuzz.test.js` 用独立参考实现对照验证）。

## 存储与恢复

```
db/
  wal.log                  # 追加写日志，每行 {crc, payload}，payload 为一批记录
  manifest.json            # {version, lastSeq, segments:[{id,file,count,minTs,maxTs}]}，tmp+rename 原子更新
  segment-000001.jsonl     # 不可变段（WAL 超过 128 条时落盘）
  segment-000001.idx.json  # 段时间索引（排序条目 + min/max ts）
```

故障点与恢复行为（`recover`）：

1. **WAL 提交前**：WAL 尾部出现半行/坏 CRC —— 截断到最后的有效前缀（`truncated_bytes`）。
2. **segment 落盘后、manifest 更新前**：产生 manifest 未引用的孤儿 segment —— 删除
   （`removed_orphans`），数据仍以 WAL 为准，不会重复计数。
3. **manifest 更新后、索引写入前**：索引缺失或与 manifest 不一致 —— 从 segment 数据重建
   （`rebuilt_indexes`）。

恢复后只暴露最后已提交前缀；已被 manifest 覆盖的 WAL 记录会被丢弃（`dropped_wal_records`）。

## 退出码（真实验证）

| 情形 | 退出码 |
| --- | --- |
| append/query/recover 成功 | 0 |
| 查询词法/语法/静态类型错误（stderr 输出 `QUERY_ERROR: ...`） | 2 |
| 恢复失败（stderr 输出 `RECOVERY_ERROR: ...`，如目录不存在、manifest 损坏、manifest 引用的 segment 丢失） | 1 |
| 其他运行错误（stderr 输出 `ERROR: ...`，如日志文件缺失、记录字段非法、参数缺失） | 1 |

## 测试结果

`node --test`（Node v22.22.1）实测输出：

```
# tests 6
# pass 6
# fail 0
```

6 个测试文件全部通过，共 37 个子测试（pass 37 / fail 0）：

- `test/dsl.test.js`（11）：范围/模式/聚合查询、时间字面量、数字单位、let 作用域与遮蔽、
  优先级、未知字段与类型错误、语法错误。
- `test/ordering.test.js`（2）：乱序时间按 `(ts, device, seq)` 排序（WAL 与 segment 混合）。
- `test/recovery.test.js`（10）：三类故障点恢复、坏 CRC 截断、过期索引重建、重复 WAL 去重、
  干净库无操作。
- `test/fuzz.test.js`（4）：≤500 条随机日志（种子 1/2/3，n=137/500/42）与独立全量扫描参考
  算法逐查询对比；时间索引裁剪路径与未裁剪扫描结果一致。
- `test/cli.test.js`（10）：append/query/recover 往返、退出码 0/1/2、`RECOVERY_ERROR`、
  损坏尾部端到端恢复、聚合输出。

## 代码结构

```
src/lexer.js     词法分析（时间字面量、数字单位、glob 字符串）
src/parser.js    Pratt 解析器（let/select/where、and/or/not、比较）
src/checker.js   静态模式检查（字段类型、词法作用域）
src/compiler.js  AST → 字节码；ts 常量界提取
src/vm.js        字节码虚拟机
src/storage.js   WAL/segment/manifest/索引、append、flush、recover
src/query.js     查询执行（索引裁剪 + 全谓词求值 + 排序 + 聚合）
src/cli.js       命令行入口（可注入 IO 的 run(argv)，便于测试）
src/crc32.js     CRC-32（WAL 记录校验）
src/errors.js    QueryError / RecoveryError
```
