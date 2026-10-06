# qcert — 离线批抽样质检判定与审计证书

纯 Node.js 22 标准库实现，单机离线，无第三方依赖。质检部门用 DSL 编写抽样规则，
编译为字节码后在 VM 上按（批量、已抽样数、累计缺陷、最差缺陷等级）输出
`ACCEPT` / `REJECT` / `CONTINUE`。`CONTINUE` 是合法的未决状态（继续抽样），
不是错误，也不等同"不可满足"。每次判定签发含**规则哈希、样本哈希、版本号**的
证书；样本标签更正产生新样本版本，旧证书标记 `SUPERSEDED` 但永不删除；
rollback 只能回到未提交草稿，已发布判定始终可追溯。

## 架构

```
src/lexer.js    词法层：批号 #B-2024-0001、百分比 2.5%、计数 42、日期 2025-01-31、字符串、注释
src/parser.js   Pratt 解析器：not > 比较 > and > or，算术优先级，when/otherwise 分句
src/checker.js  静态类型：quantity / ratio / defect_level / boolean；词法作用域
                （param 外层、let 逐层遮蔽、decide 块内 let 不外泄）
src/compiler.js AST -> 字节码（PUSH/LOAD/STORE/算术/比较/AND/OR/NOT/JIF/EMIT）
src/vm.js       栈式 VM，带运行时类型标签；EMIT 产出三态判定
src/samples.js  samples.jsonl 解析（带行号报错）、聚合、样本集哈希
src/cert.js     证书签发与完整性验证（规范 JSON 的 SHA-256）
src/store.js    SampleStore（版本/草稿/rollback）+ Journal（仅追加、取代标记）
bin/qcert.js    CLI
test/           node:test 测试，含独立树遍历参考实现的全枚举交叉验证
```

## 规则 DSL

```
rule "AQL-L2" version 3 effective 2025-01-01 {
  param batch_size: quantity
  param sampled: quantity
  param defects: quantity
  param worst: defect_level          // none < minor < major < critical

  let sample_size: quantity = max(1, floor(batch_size * 10%))
  let accept_max: quantity = floor(sample_size * 5%)

  decide {
    when worst >= critical -> REJECT
    when defects >= accept_max + 1 -> REJECT
    when sampled >= sample_size and defects <= accept_max -> ACCEPT
    otherwise -> CONTINUE
  }
}
```

- 类型规则：`quantity*/ratio → quantity`，`quantity/quantity → ratio`（可与 `5%` 比较），
  比较要求两侧同型，`and/or/not` 仅作用于布尔，guard 必须为布尔。
- 内建函数：`floor ceil abs min max`。
- 词法作用域：后一个 `let` 可遮蔽同名 param/let，之前的表达式仍按原绑定解析。

## 样本文件 samples.jsonl

```
{"type":"batch","id":"B-2026-0042","size":1000}     // 恰好一条，必需
{"type":"sample","id":"s001","defects":0}
{"type":"sample","id":"s002","defects":1,"level":"minor"}
```

`type` 缺省为 `sample`，`defects` 缺省 0，`level` 缺省 `minor`（取 minor|major|critical）。
聚合：`sampled`=样本行数，`defects`=缺陷求和，`worst`=有缺陷样本中的最高等级。

## CLI

```
qcert decide <rule.dsl> <samples.jsonl> --cert <c.json> [--store <s.json>] [--journal <j.jsonl>]
qcert verify <c.json> [--journal <j.jsonl>]
qcert commit <samples.jsonl> [--store <s.json>]     # 提交样本新版本（内容相同则幂等）
qcert draft  <samples.jsonl> [--store <s.json>]     # 暂存未提交草稿（更正工作区）
qcert rollback [--store <s.json>]                   # 仅可回滚未提交草稿
qcert compile <rule.dsl>                            # 打印编译后字节码
```

`--store` 缺省 `<samples>.store.json`，`--journal` 缺省 `./qcert-journal.jsonl`。

### 退出码（真实行为，由 test/cli.test.js 锁定）

| 退出码 | 含义 |
|---|---|
| 0 | 成功。decide 三种判定（含 CONTINUE 未决）均为 0；verify 完整性通过（状态 ACTIVE/SUPERSEDED/UNKNOWN 均为 0） |
| 1 | 证书完整性/结构验证失败（如内容被篡改，哈希不符） |
| 2 | 输入/用法错误：DSL 词法/语法/类型错误、samples.jsonl 错误、文件缺失、非法 rollback、未知命令。DSL 与样本错误均带 `文件:行:列` |

示例：

```
$ node bin/qcert.js decide examples/aql-l2.dsl examples/samples.jsonl --cert c.json
decision=CONTINUE sample_version=1 cert=sha256:0eab… (pending: keep sampling)   # exit 0
$ node bin/qcert.js verify c.json
OK cert=sha256:0eab… decision=CONTINUE status=ACTIVE                            # exit 0
```

## 审计链

- **证书**（`qcert/1`）：`rule_hash`（DSL 源文本 SHA-256）、`sample_hash`（样本集规范哈希）、
  `rule_version`、`sample_version`、判定、输入快照、`cert_hash`（内容哈希）。篡改任何字段
  都会导致 `verify` 以退出码 1 失败。
- **Journal**（仅追加 JSONL）：每次 decide 追加一条记录并把同规则此前的 ACTIVE 证书列入
  `supersedes`。旧证书文件不被改写或删除，`verify` 查 journal 报告 `SUPERSEDED`，
  完整性仍可验证（退出码 0）。
- **SampleStore**：已提交版本不可变；更正 = 新版本；`rollback` 只允许丢弃未提交草稿，
  对无草稿状态调用即"非法回滚"，退出码 2。已发布判定与版本永久可追溯。

## 测试

```
node --test
```

最近一次运行结果（真实输出）：**9 个测试文件，pass 9 / fail 0；共 45 个测试，全部通过，0 失败**。

验收覆盖：

1. 接受/拒绝/继续三路径 — `test/vm.test.js`、`test/cli.test.js`
2. 缺陷数等于阈值边界（`defects == accept_max` 接受、`== accept_max+1` 拒绝）— `test/vm.test.js`
3. 更正后重新判定，旧证书可验证但状态 SUPERSEDED — `test/cli.test.js`、`test/store.test.js`
4. 非法回滚（无未提交草稿）— `test/store.test.js`、`test/cli.test.js`（退出码 2）
5. ≤10 个样本的全部输入（批量 1..10 × 抽样 0..批量 × 缺陷 0..抽样 × 4 个缺陷等级，
   共 1140 + 另一含比例/取整/遮蔽规则的 1140 组）与独立树遍历参考实现逐一比对 — `test/reference.test.js`
