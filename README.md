# dimformula

单机离线、仅标准库的带物理单位实验公式更正库与 CLI（Node.js 22，ESM）。

## 功能

- Pratt 解析：数字、变量、`+ - * / ^`、比较（`< <= > >= == !=`）、一元函数、括号、赋值式公式（`v=a/t`）。
- 静态量纲检查：量纲为 `{m, s, kg}` 指数向量；内置 `1, m, s, kg, Hz, m/s, m/s^2, N, J, W, Pa`。
  - 加减与比较要求同量纲；乘除按指数向量合并；`^` 指数须为数字字面量。
  - 一元函数声明参数量纲：`sin/cos/tan/asin/acos/atan/exp/ln/log10`（无量纲→无量纲）、`abs`（任意→同）、`sqrt`（指数减半）。
- `correct` 生成新版本；`undo`/`redo` 在不可变（深冻结）AST 版本间移动；失败时当前版本不变。
- 每个通过检查的版本生成「规范化 AST + 量纲表」的 SHA-256 证书。
- 错误均带错误码与源码位置：`DIM_MISMATCH`（含两侧量纲）、`UNKNOWN_VARIABLE`、`PARSE_PAREN`、`PARSE_TOKEN`、`DIM_FUNCTION_ARG`、`UNKNOWN_FUNCTION` 等。

## 使用

```sh
node src/cli.js examples/input.json     # 从文件读取
cat examples/input.json | node src/cli.js   # 或从 stdin
node --test                             # 运行测试
```

输入 JSON：`{"variables": {"a": "m", ...}, "commands": [{"op": "correct", "formula": "v=a/t"}, {"op": "undo"}, {"op": "redo"}, {"op": "current"}]}`；
输出每条命令的推断量纲、版本号与证书，或结构化错误（当前版本保持不变）。

## 结构

- `src/parser.js` — 词法 + Pratt 解析（含括号错误定位）
- `src/checker.js` — 量纲推断与函数声明表；`subexpressionTable` 枚举全部子表达式量纲
- `src/dimensions.js` — 指数向量量纲代数与内置量纲表
- `src/store.js` — 不可变版本历史（correct/undo/redo）
- `src/certificate.js` — 规范化 AST + 量纲表的 SHA-256
- `src/cli.js` — JSON 输入/输出 CLI（`run()` 可编程调用）
- `test/formula.test.js` — node:test 验收测试
