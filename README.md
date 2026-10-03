# evidence-chain

离线单机证据引用链校验库与 CLI。仅使用 Node.js 22 标准库与 `node:test`，无任何第三方依赖。

## 语言

```
evidence E1            # 声明证据
rule R1                # 声明规则
claim C1 = E1 |> R1    # 声明声明（claim），右值必须是 claim 表达式
alias X = E1 & E2      # 别名，仅在当前块及子块可见
{ ... }                # 嵌套作用域
revoke E2              # 撤销证据（undo/redo 可恢复；新操作清空 redo）
undo / redo
```

表达式运算符（Pratt 解析，结合力从松到紧）：

- `C requires E`：claim 依赖证据或 claim
- `A |> R`：证据/claim 经规则推导为 claim
- `A & B`：同类型合取（规范化时操作数排序）

静态类型：`evidence`、`rule`、`claim` 三种，类型错误（如 `&` 混合规则）直接拒绝。

## 证书链

每个提交包含：规范化术语、父证书、作用域哈希（当前可见别名的规范化绑定集的 SHA-256）。
证书为 `HMAC-SHA256(key, parent\nscopeHash\nid\ntype\nterm)`。`verify` 递归检查父证书、
静态类型与签名；撤销证据后，所有传递依赖它的 claim 失效。

## 用法

```
node src/cli.js run examples/chain.txt --key <hmac-key>    # 输出 JSON 判定
node src/cli.js verify ledger.json --key <hmac-key>        # 校验证书链
node --test                                                # 运行测试
```

成功输出 JSON 判定（退出码 0）；解析/类型/作用域/签名错误输出错误文本并以退出码 1 结束。

## 结构

- `src/parser.js`：词法分析与 Pratt 解析器
- `src/term.js`：静态类型、规范化、依赖计算、规范项解析
- `src/ledger.js`：提交、HMAC 证书、撤销/undo/redo、递归链校验
- `src/build.js`：作用域处理与账本构建
- `src/cli.js`：命令行入口（`run` / `verify`）
- `examples/`：验收场景脚本
- `test/`：`node:test` 测试
