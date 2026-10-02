# logdb — 单机设备日志库与查询 CLI

Node.js 22、仅标准库、全程单机离线。JSONL 设备日志（字段 `ts`、`device`、`code`、`value`）
的追加写存储，带 WAL / segment / manifest 的崩溃恢复，以及一个编译为字节码执行的查询 DSL。

## 快速开始

```bash
node src/cli.js append log.jsonl --db dir     # 追加 JSONL 日志（--db 缺省 ./logdb）
node src/cli.js query q.dsl --db dir          # 执行查询文件
node src/cli.js recover --db dir              # 崩溃恢复
node --test                                   # 运行全部测试
```

日志行示例（`ts` 接受 epoch 毫秒或 ISO-8601 字符串，内部统一为毫秒）：

```json
{"ts":"2026-10-01T08:00:00Z","device":"pump-1","code":"I100","value":12.5}
```

## 查询 DSL

```
let hot = value > 1.5k;                        # let 子查询，词法作用域，可遮蔽、可引用先前的 let
ts >= 2026-10-01T00:00:00Z and ts < 2026-10-02 # 时间字面量（ISO-8601，可省略时间部分）
  and (device =~ "pump-*" or hot)              # 设备模式：* 任意串、? 单字符；!~ 为否定
| count, avg(value) by device                  # 可选聚合管道：count/sum/avg/min/max + by 分组
```

- 词法层：时间字面量、带单位数字（`1.5k`=1500、`2M`、`3G`）、字符串/设备模式、`#` 行注释。
- 语法层：Pratt 解析 `not` > `and` > `or`，比较符 `== != < <= > >= =~ !~`（非结合），括号。
- 静态检查：字段类型表 `ts:time, device:string, code:string, value:number`；
  未知字段、比较两侧类型不符、非字符串模式匹配、聚合非数值字段、`by` 非字符串字段均报错。
- 编译：表达式编译为栈式字节码（`CONST/FIELD/EQ/.../MATCH/JFALSE/JTRUE/NOT/CALL`），
  `let` 子查询编译为独立 chunk 由 `CALL` 调用；从顶层合取项提取 `ts` 窗口用于时间索引裁剪。
  索引覆盖段内全部行，裁剪是精确的，结果与全量扫描一致（测试④双重验证）。
- 结果排序：`ts, device, seq`（seq 为追加时分配的全局序号），乱序写入也按此序输出。

## 存储与恢复

```
db/
  wal.log                  # 帧：[len u32][payload][crc32 u32]
  manifest.json            # {version,nextSeq,nextSeg,segments[],checksum}，tmp+rename 原子更新
  segments/seg-000001.jsonl
  segments/seg-000001.idx.json   # 时间索引：按 ts 排序的 [ts,row]
```

追加顺序：WAL fsync（提交点）→ segment fsync → manifest 更新 → 建索引 → 截断 WAL。
三个故障点及恢复行为：

| 故障点 | 恢复行为 |
| --- | --- |
| WAL 提交前（尾部撕裂/校验失败） | 截断校验失败的尾部，只保留已提交前缀 |
| segment 落盘后、manifest 前 | 孤儿 segment 删除，WAL 重放为新 segment |
| manifest 更新后、索引前 | 重建缺失索引；WAL 中已提交记录按 seq 去重后截断 |

恢复后只暴露最后已提交前缀。manifest 损坏、段文件缺失/损坏、目录不存在等不可恢复
情况抛 `RecoveryError`，CLI 输出 `RECOVERY_ERROR: ...`。

## 退出码（真实验证）

| 退出码 | 含义 | 验证 |
| --- | --- | --- |
| 0 | 成功（append/query/recover） | `append=0 query=0 recover=0` |
| 1 | 一般错误：I/O、非法日志行、未知命令、恢复失败（stderr 打 `RECOVERY_ERROR:`/`ERROR:`） | `recover-missing=1` |
| 2 | 查询语法错误（stderr 打 `SYNTAX_ERROR:`） | `syntax=2` |
| 3 | 查询静态错误：未知字段、类型错误（stderr 打 `TYPE_ERROR:`） | `type=3` |

## 测试结果

测试命令 `node --test`（node:test，无任何依赖）。最近一次真实运行：

```
# tests 5   （5 个测试文件，共 39 个子测试）
# pass 5
# fail 0
```

覆盖验收项：

- ① 范围、模式、聚合查询：`test/query.test.js`（range / pattern / 聚合 + by 分组）。
- ② 乱序时间排序：`test/storage.test.js`、`test/query.test.js` 校验 `ts,device,seq` 序。
- ③ 三类故障点恢复：`test/recovery.test.js`（WAL 提交前、manifest 前、索引前，含混合崩溃）。
- ④ ≤500 条随机日志一致性：`test/query.test.js` 用确定性 PRNG 生成 n=0/1/7/128/500，
  引擎（索引路径）对照独立全量扫描参考算法（直接读 segment/WAL + JS 谓词）。
- ⑤ 未知字段、类型错误、损坏尾部：`test/cli.test.js`、`test/dsl.test.js`。

## 代码结构

```
src/crc32.js     CRC32（WAL 帧与 manifest 校验）
src/storage.js   WAL/segment/manifest/索引、appendBatch、recover、已提交视图
src/lexer.js     词法器（时间字面量、数字单位、字符串/模式）+ DslSyntaxError/DslTypeError
src/parser.js    Pratt 解析器（and/or/not、比较、let 词法作用域、聚合管道）
src/checker.js   静态类型检查（字段类型表、聚合/by 检查）
src/compiler.js  字节码编译 + ts 窗口提取
src/vm.js        栈式字节码 VM、glob 匹配、索引候选二分
src/query.js     查询执行（索引裁剪 + 排序 + 聚合）、参考全量扫描
src/cli.js       CLI（runCli 返回退出码，进程内可测）
```
