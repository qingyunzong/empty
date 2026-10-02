# offline-planner

断电风险下的单机离线排程系统。Node.js 22，仅使用标准库，全程离线。
提供 DSL（班次日历 / 维护窗 / 作业时长与优先级 / 资源约束）、事务
（add-job / move-job / savepoint / rollback / commit）、WAL 持久化与故障恢复。

## 运行

```sh
node bin/plan.js init   <dir>            # 初始化持久化目录（wal.log / state.json）
node bin/plan.js apply  <dir> <file|->   # 执行脚本（- 表示 stdin），提交事务
node bin/plan.js recover <dir>           # 恢复到最后已提交事务（幂等修复 state）
node bin/plan.js export <dir>            # 导出当前已提交计划（JSON）
```

## 退出码（真实行为，由 test/cli.test.js、test/corruption.test.js 验证）

| 退出码 | 含义 | 输出 |
|---|---|---|
| 0 | 成功 | `OK` / `COMMITTED gen=N jobs=M` / `RECOVERED gen=N jobs=M` / 计划 JSON |
| 1 | 用法、词法/语法、静态类型、事务错误 | stderr: `ERROR: ...` |
| 2 | 领域不可行（作业无法排入班次/维护窗，或约束被违反） | stdout: `INFEASIBLE` |
| 3 | 持久化文件损坏（state.json / checkpoint.json 校验失败或缺失） | stdout: `RECOVERY_ERROR` |

## DSL 概览

```
line A                                   # 产线
calendar A { shift 08:00-12:00  shift 13:00-17:00 }   # 班次日历（每日）
maintenance A @2026-10-05T10:00 for 1h   # 维护窗（时刻 + 时长）

let base = 10                            # 脚本级绑定（词法作用域）
template t(p) { duration 30m  priority p + base }     # 模板，捕获定义处环境
job J1 = t(1)                            # 由模板实例化作业
add-job J2 { duration 45m  priority 7  lines A, B }   # 事务命令：新增作业
move-job J2 B                            # 事务命令：把作业固定到产线 B

constraint cap = count(A) <= 3 && load(B) <= 8h       # 资源约束

savepoint s1                             # 可嵌套
rollback s1                              # 回滚到 s1：撤销其后状态、移除其后保存点，
                                         # s1 及更早保存点仍有效
commit                                   # 提交全部活动事务
```

- 类型系统：`Int`、`Dur`（`30m`/`2h`/`1d`）、`Inst`（`@YYYY-MM-DDTHH:MM`）、
  `Line`、`Bool`。静态检查时刻/时长/产线的运算与比较（如 `count(A) <= 8h`
  报类型错误：Int 与 Dur 不可比较）。
- 约束表达式由 Pratt 解析器解析（优先级：`||` < `&&` < 比较 < `+ -` < 一元），
  类型检查后编译为栈机字节码；`count(line)`/`load(line)` 为内建函数。
  约束按所引用产线做增量验证：仅重估被事务操作或放置变化触及的约束。
- 模板具词法作用域：模板体在定义处环境中求值，参数遮蔽外层绑定；
  之后的同名 `let` 不影响已定义模板。
- 约束必须自包含（只能引用产线与字面量），以便恢复时从持久化源码重编译。

## 调度语义

- 作业必须完整落在某条可用区间内（班次并集减去维护窗），同线不重叠。
- 目标：最小化 `Σ priority × 完成时刻`，其次 makespan，再按作业 id 的
  (line, start) 字典序确定性地打破平局（并列优先级 => 按 id 排序）。
- 搜索空间 ≤ 2,000,000 叶时精确枚举（产线分配 × 线内排列，最早开工解码），
  否则退化为贪心列表调度。`test/enumeration.test.js` 用独立的暴力枚举参考
  实现（`src/reference.js`）对 ≤7 作业的 40 个随机用例逐一比对放置结果。

## 持久化与恢复

目录内容：`wal.log`（追加式、逐条 SHA-256 校验的记录）、`state.json`、
`checkpoint.json`（均为原子写入 + 校验和的快照）。

提交顺序：① WAL commit 记录（fsync）→ ② state.json → ③ checkpoint.json
→ ④ 截断 WAL。三类故障点均可恢复：

- WAL 提交前崩溃：未提交的操作尾部被忽略；
- WAL 提交后、state 前崩溃：重放已提交 WAL 并幂等修复 state.json；
- state 后、checkpoint 前崩溃：过期 checkpoint 被忽略。

恢复结果等于最后一次 commit。WAL 中校验失败的尾部同样被忽略；
state.json / checkpoint.json 校验失败或缺失则报 `RECOVERY_ERROR`（退出码 3）。

## 测试

```sh
node --test
```

最近一次真实运行（2026-10-03，Node v22.22.1）：

- `node --test`：6 个测试文件，**6 通过 / 0 失败**，退出码 0；
- 逐文件展开的子测试合计 **34 通过 / 0 失败**
  （dsl 10、txn 5、recovery 4、corruption 5、enumeration 4、cli 6）。

覆盖验收项：① 可行计划与并列优先级（cli/enumeration）；② 嵌套回滚（txn）；
③ 三类故障夹具恢复（recovery）；④ ≤7 作业与枚举参考实现比对（enumeration）；
⑤ checksum 损坏（corruption）。

## 目录结构

```
bin/plan.js      CLI 入口
src/lexer.js     词法分析（时刻/时长/时间字面量）
src/parser.js    语句解析 + Pratt 表达式解析
src/types.js     静态类型检查（Int/Dur/Inst/Line/Bool）
src/bytecode.js  约束 -> 字节码编译、栈机 VM、增量验证器
src/schedule.js  调度器（精确枚举 + 贪心回退）
src/reference.js 独立暴力枚举参考实现（测试比对用）
src/txn.js       事务与嵌套保存点
src/store.js     WAL / state / checkpoint 持久化与恢复
src/dsl.js       解释器（声明、模板、事务命令、提交）
src/cli.js       命令分发与退出码
test/            node:test 测试
support/         测试辅助（非测试文件）
```
