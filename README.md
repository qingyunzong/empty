# dimcheck

带物理单位的实验公式更正库及 CLI。单机离线，Node.js 22，仅标准库，测试用 `node:test`。

## 功能

- **公式语言**：数字、变量、`+ - * /`、比较（`< > <= >= == !=`）、一元函数（`sin cos tan exp ln log abs sqrt`）、括号、顶层赋值（`v=a/t`）。
- **Pratt 解析**：`src/parser.js`，记号带源码位置，括号/语法错误给出列号。
- **静态量纲检查**：`src/checker.js`。量纲为 `[L, M, T]` 指数向量；加减与比较要求同量纲，乘除按指数向量合并，一元函数声明参数量纲（如 `sin` 要求无量纲）。
- **内置有限量纲**：`1, m, s, kg, Hz, m/s, m/s^2, N, Pa, J, W`（`src/units.js`），未命名向量回退为 `L^a*M^b*T^c` 形式。
- **版本与证书**：`src/versioning.js`。`correct` 仅在解析+检查通过后追加不可变版本（并丢弃 redo 分支）；`undo`/`redo` 只移动指针，不修改 AST。每个通过检查的版本对「规范化 AST + 量纲表」的规范化 JSON 计算 SHA-256 证书。赋值变量（如 `v=a/t` 中的 `v`）并入后续版本可用的量纲表。
- **错误即拒绝**：量纲不一致（含位置与两侧量纲）、未知变量、括号错误都会拒绝更正，当前版本保持不变。

## CLI

```sh
node src/cli.js examples/spec.json   # 或从 stdin 读入
```

输入 JSON：`{"variables": {"a": "m", ...}, "commands": [...]}`，
命令：`correct`（带 `formula`）、`undo`、`redo`、`status`、`enumerate`（枚举当前版本全部子表达式量纲）。
输出 JSON：每条命令的推断量纲、版本号与证书，或结构化错误。

## 测试

```sh
node --test
```
