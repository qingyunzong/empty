# 观测站公式更正库

单机离线 Node.js 22，仅标准库。维护具名公式的不可变版本，支持 `def`、`correct`、`undo`、`redo`、`certify`。

## CLI

```sh
node cli.js <<'CMDS'
def v = a/2
correct v = a/2[t]
certify v
undo v
redo v
CMDS
```

- 成功：每条命令向 stdout 输出单行 JSON，如 `{"ok":true,"name":"v","version":2,"sha256":"..."}`。
- 失败（词法 / 类型 / 未知名称 / 非法状态）：向 stderr 输出 `error: ...`，退出码 1，且不产生部分版本。

## 语法

- 普通表达式：数字、标识符、函数调用 `f(x, y)`、一元负号、二元运算。
- 优先级（低→高）：`||` < `&&` < 比较（`== != < > <= >=`）< `+ -` < `* /` < 一元 `-` < 调用 / 后缀片段。
- 单位片段：`[m/s]`，作为后缀标注紧贴其前的表达式。
- 证据片段：`[[ev-1]]`，同为后缀标注；不可作为二元运算操作数、不可被一元负号作用。

## 版本与证书

- `def` 创建版本 1；`correct` 追加新的不可变版本并清空 redo 分支。
- `undo` 回退到上一版本；`redo` 仅在存在被回退且未发生新更正的版本时可用。
- `certify` 输出 `{name, version, sha256}`，其中 `sha256` 是对 `{ast, name, version}`（AST 为规范化形式）的 SHA-256。

## 测试

```sh
node --test
```

真实 stdout / stderr / 退出码见 `run-record.txt`。
