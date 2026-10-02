# qcert — 离线抽样质检规则引擎与证书审计链

纯 Node.js 22 标准库实现，单机离线，零依赖。包含：规则 DSL（词法/Pratt 解析/静态类型）、
字节码编译器与 VM、版本化样本集、证书审计链，以及 `decide` / `verify` / `rollback` CLI。

## 快速开始

```sh
node bin/qcert.js decide examples/rule.dsl examples/samples.jsonl --cert c.json
node bin/qcert.js verify c.json
node --test        # 运行全部测试
```

## 规则 DSL

```dsl
rule "aql-sequential" version 1 {
  param batch_size: quantity      # 批量
  param sampled: quantity         # 已抽样数
  param defects: quantity         # 累计缺陷
  param severity: level           # 缺陷等级 minor < major < critical

  const max_defects: quantity = 2
  const max_rate: ratio = 10%
  const effective_from: date = 2024-01-01
  const batch_id: batch = B2024-001

  when defects > max_defects or severity >= critical => REJECT
  when let rate: ratio = defects / sampled in sampled > 0 and rate > max_rate => REJECT
  when sampled >= 5 and defects <= max_defects => ACCEPT
  otherwise => CONTINUE
}
```

- **词法层**：批号字面量（`B2024-001`）、百分比（`10%`、`2.5%`）、计数（`42`）、日期（`2024-01-31`），`#` 注释。
- **Pratt 解析**：`or` < `and` < `not` < 比较 < 加减 < 乘除；`not a == b` 意为 `not (a == b)`。
- **静态类型**：`quantity`（数量）、`ratio`（比例，精确分数运算）、`level`（缺陷等级）、`date`、`batch`、`bool`；
  类型错误在编译期报出并带行号。`quantity / quantity → ratio`。
- **词法作用域**：`param`/`const` 在规则作用域；每个 `when` 子句的 `let` 绑定构成独立内层作用域，
  可遮蔽外层同名绑定，子句之间互不可见。
- **编译为字节码**：`PUSH/LOAD/STORE/ADD/.../JMP_IF_FALSE/VERDICT/HALT` 栈式指令集（见 `src/compiler.js`）。
- **VM 判定**：根据批量、已抽样数、累计缺陷输出 `ACCEPT` / `REJECT` / `CONTINUE`。
  `CONTINUE` 是合法的未决状态：无子句命中且到达 `HALT` 时返回，绝不用作错误哨兵。

## 样本文件（JSONL）

```jsonl
{"type":"batch","size":100}
{"type":"sample","id":"S1","defects":0,"severity":"minor"}
{"type":"sample","id":"S2","defects":1,"severity":"major"}
{"type":"correction","id":"S2","defects":0,"reason":"label misread"}
```

初始 `sample` 记录构成版本 1；每条 `correction` 产生一个新版本。`decide` 对每个尚未出证的版本
逐一判定并追加证书。

## 证书与审计链

每次判定生成一张证书，包含：**规则哈希**（DSL 源文本 SHA-256）、**样本哈希**（规范化样本集
SHA-256）、**版本号**、判定结果、前序证书哈希（链式链接）与证书哈希。

- 样本更正产生新版本；旧证书标记为 `SUPERSEDED`，**不可删除**，`verify` 仍可验证其哈希与链式完整性。
- `--draft` 出的证为未提交草稿（`DRAFT`）；`rollback --to N` **只能**回到未提交草稿，
  试图回滚已发布（`ACTIVE`/`SUPERSEDED`）判定会被拒绝（exit 2），已发布判定始终可追溯。
- 重复 `decide` 会重算样本历史并与链上证书比对，历史被篡改则拒绝出证。

## CLI

```
qcert decide <rule.dsl> <samples.jsonl> --cert <chain.json> [--draft]
qcert verify <chain.json>
qcert rollback <chain.json> --to <version>
```

**退出码（实测）**

| 退出码 | 含义 | 触发场景 |
|---|---|---|
| 0 | 成功 | decide/verify/rollback 正常完成 |
| 1 | 验证失败 | 证书哈希不符、链断裂、状态不一致 |
| 2 | 输入/用法错误 | DSL 词法/语法/类型错误（带行号）、JSONL 错误（带行号）、非法回滚、参数缺失 |

错误信息格式：`<文件>:<行号>: <原因>`，例如 `rule.dsl:3: cannot order-compare quantity with ratio`。

## 测试

```sh
node --test
```

实测结果（Node v22.22.1）：**8 个测试文件，58 个测试，58 通过 / 0 失败**。

验收覆盖：

1. 接受 / 拒绝 / 继续三路径 — `test/vm.test.js`
2. 缺陷数等于阈值边界（`defects == max_defects` → ACCEPT，多 1 → REJECT）— `test/vm.test.js`
3. 更正后重新判定，旧证书可验证且状态为 `SUPERSEDED` — `test/audit.test.js`、`test/cli.test.js`
4. 非法回滚已发布判定被拒绝（exit 2），草稿回滚合法 — `test/audit.test.js`、`test/cli.test.js`
5. ≤10 个样本的全部缺陷向量（2^11−1 × 3 严重度 = 6141 例）及批量/缺陷网格，
   VM 与独立树遍历参考实现（`src/reference.js`）逐一比对一致 — `test/enumeration.test.js`

## 目录结构

```
bin/qcert.js      CLI 入口
src/lexer.js      词法分析（批号/百分比/计数/日期字面量，行号跟踪）
src/parser.js     Pratt 解析器
src/types.js      静态类型检查（词法作用域）
src/compiler.js   AST → 字节码
src/vm.js         字节码虚拟机
src/reference.js  独立参考解释器（验收比对用）
src/samples.js    JSONL 样本集与版本化
src/ledger.js     证书链、验证、回滚
src/engine.js     decide 流程编排
src/cli.js        命令行
test/             node:test 测试套件
examples/         示例规则与样本
```
