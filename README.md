# 观测站公式更正库及 CLI

单机离线、Node.js 22、仅标准库。维护具名公式的不可变版本，支持
`def` / `correct` / `undo` / `redo` / `certify`。

## 文件

- `formula.js` — 库：词法器、Pratt 解析器、版本存储、SHA-256 证书
- `cli.js` — 命令行界面（同时导出 `runSession(input)` 供进程内测试）
- `test/formula.test.js` — `node:test` 测试
- `run-record.txt` — 真实 stdout / stderr / 退出码记录

## CLI 协议

从 stdin 读命令，每行一条；成功向 stdout 输出单行 JSON；
词法 / 类型 / 未知名称等错误向 stderr 输出 `error:` 开头文本并以退出码 1 终止，
失败的命令不提交任何部分版本。

```
def <name> = <expr>       定义公式（版本 1）
correct <name> = <expr>   提交更正版本（清空 redo 分支）
undo <name>               回退上一版本
redo <name>               无新更正时重做
certify <name>            输出 {name, version, sha256} 证书
```

## 表达式语法

- 词法器区分：普通表达式、`[m/s]` 单位片段、`[[证据编号]]` 证据片段（后两者为后缀，绑定最紧）
- Pratt 解析器优先级（低→高）：`||` < `&&` < 比较（`== != < <= > >=`）< `+ -` < `* /` < 一元 `-` < 调用 / 单位 / 证据
- 函数调用限定内置表（`sqrt abs exp log sin cos tan floor ceil round min max pow atan2`），
  未知函数或参数个数错误为类型错误
- 证书 = SHA-256(JSON.stringify({name, version, ast: canonical(AST)}))

## 运行

```
node --test                          # 运行测试
printf 'def v = a/3[t]\ncertify v\n' | node cli.js
```
