# obs-stream-corrector

单机离线观测流更正库与 CLI（Node.js 22，仅标准库，测试用 `node:test`）。

## 结构

- `src/lexer.js` — 词法器：区分普通 CSV 行、`#!correction` 指令块与引用字符串（CSV 支持 `"..."` 引用与 `""` 转义）。
- `src/compiler.js` — 把脚本编译为字节码：`map`（STORE）、`clamp`、`filter`（JZ→DROP）、算术（ADD/SUB/MUL/DIV/NEG）、条件跳转（JZ/JMP 目标补丁）。
- `src/vm.js` — 栈式 VM。clamp 越界自动截断（非错误）；缺字段、除零、类型错误抛 `VMError`；`CrashError` 用于 `--crash N` 崩溃注入。
- `src/runner.js` — 批处理运行器：每批开始写 checkpoint（记录已成功处理的序号），批完成后原子提交（tmp + rename）。批内任何 `VMError` 使整批回滚，已发出的更正全部撤销，输出错误与已提交边界。
- `src/cli.js` — 命令行入口。

## 脚本语言

```
#!correction
map total = price * qty
clamp price 0 100
filter qty > 0
if qty >= 4 then bonus = qty * 10
#!end
```

指令块外的行按 CSV 解析：首行为表头，其余行追加为输入记录。

## CLI

```
node src/cli.js --input records.json --script corrections.cor \
  [--batch-size N] [--state state.json] [--crash N] [--output out.json]
```

- 退出码：`0` 成功，`1` 更正失败（整批回滚），`2` 用法错误，`3` 模拟崩溃。
- 成功输出：`{ ok, records, batches, committedThrough }`（记录数组 + 批次元数据）。
- 失败输出：`{ ok:false, error:{message, recordIndex, pc, rolledBackBatch}, committedThrough, batches, records }`。
- `--crash N`：在执行第 N 条字节码后、下一 checkpoint 前崩溃；状态文件停留在最后已提交批次。
- 带 `--state` 重跑：从最后已提交批次之后继续，已提交记录不会二次生效（幂等）。

## 测试

`node --test`

## 真实测试结果（2026-10-02，Node v22.22.1）

```
1..4
# tests 4
# pass 4
# fail 0
```

验收场景（`test/acceptance.test.js`）：

1. 5 条记录正常结果与手算一致（`id:2` 被 filter 丢弃，`price` 经 `*2` 后 clamp 到 `[0,100]`，`qty>=4` 得 `bonus=40`）。
2. 第 4 条记录（index 3）除零 → 整批（records 2..3）回滚，`committedThrough=1`，仅保留批次 0 的两条已提交记录。
3. `--crash 40` 在批次 1 提交前崩溃（退出码 3，状态文件 `committedThrough=1`），带状态文件重跑后 `records`、`batches`、`committedThrough` 与无故障运行完全一致；再次重跑结果不变（无二次生效）。
