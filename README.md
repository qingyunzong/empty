# lexpat

`lexpat` 是一个支持**可嵌套词法模式（mode 栈）**与**最长匹配**的词法分析库及 CLI，
仅依赖 Python 3.11 标准库。

## 语义

- spec 为 JSON 对象 `{"rules": [...]}`，每条规则：
  `{"name", "regex", "mode"="main", "push"=null, "pop"=false, "skip"=false}`。
- 起始 mode 为 `main`。在每个输入位置尝试**当前 mode 的全部规则**，
  取**最长匹配**；并列时取**规则序最小**者。
- 正则用 `re` 编译，**禁止捕获组**（请用 `(?:...)`），否则报 `LexError`。
- `push` 将新 mode 压栈，`pop` 弹出当前 mode（同一条规则同时设置时先 pop 再 push）。
  栈深上限 **64**：pop 空栈、压栈到深度 65 均为 `LexError`。
- 空匹配、未闭合字符串/注释（输入结束时 mode 栈未回到 `main`）、未知字符
  均报 `LexError`，错误携带 `line`、`col`（均从 1 开始）、`mode`、`expected`
  （当前 mode 可接受的规则名列表）。
- 每个 token 为 `{type, text, line, col, mode_before, mode_after}`；
  `skip: true` 的规则只消费输入（含 mode 切换）不产生 token。
- 输入文件必须是 **UTF-8 且拒绝 BOM**。

## CLI

```bash
python -m lexpat --spec spec.json --input file
```

- 成功：stdout 输出 JSONL（每行一个 token），退出码 0。
- 失败（LexError / 非法 UTF-8 / BOM / spec 非法）：stdout **不输出任何部分 token**，
  stderr 输出**一行** JSON 错误对象，退出码 **2**。

### 复现命令（真实输出）

```bash
python -m lexpat --spec examples/spec.json --input examples/input.txt
```

`examples/input.txt` 内容为 `if x "hi\t!" /* outer /* inner */ done */ 42`，
实际运行输出（退出码 0）：

```jsonl
{"type": "kw", "text": "if", "line": 1, "col": 1, "mode_before": "main", "mode_after": "main"}
{"type": "ident", "text": "x", "line": 1, "col": 4, "mode_before": "main", "mode_after": "main"}
{"type": "str_begin", "text": "\"", "line": 1, "col": 6, "mode_before": "main", "mode_after": "string"}
{"type": "str_text", "text": "hi", "line": 1, "col": 7, "mode_before": "string", "mode_after": "string"}
{"type": "str_esc", "text": "\\t", "line": 1, "col": 9, "mode_before": "string", "mode_after": "string"}
{"type": "str_text", "text": "!", "line": 1, "col": 11, "mode_before": "string", "mode_after": "string"}
{"type": "str_end", "text": "\"", "line": 1, "col": 12, "mode_before": "string", "mode_after": "main"}
{"type": "num", "text": "42", "line": 1, "col": 43, "mode_before": "main", "mode_after": "main"}
```

错误示例（第 3 行未闭合字符串，退出码 2，stdout 为空，stderr 单行）：

```json
{"error": "unexpected character '\"'", "line": 3, "col": 1, "mode": "main", "expected": ["string", "ident", "ws"]}
```

## 库用法

```python
from lexpat import Lexer, LexError, tokenize

tokens = tokenize('if x', {"rules": [
    {"name": "kw", "regex": "if|else", "mode": "main"},
    {"name": "ident", "regex": "[a-z]+", "mode": "main"},
    {"name": "ws", "regex": "\\s+", "mode": "main", "skip": True},
]})
# tokens[0] == {"type": "kw", "text": "if", "line": 1, "col": 1,
#               "mode_before": "main", "mode_after": "main"}
```

## 测试

```bash
python -m unittest discover -s tests -v
```

测试覆盖验收项：

- **A** `RandomizedConformanceTests`：嵌套块注释 + 字符串 mode 切换，
  与独立的逐字符参考扫描器（`reference_scan`，不使用 `re`）在固定种子的
  200 个随机用例上逐 token 比对一致。
- **B** `test_keyword_wins_tie_over_identifier`：同长关键字/标识符并列选关键字。
- **C** `test_unterminated_string_line3_single_error`：第 3 行未闭合字符串
  只报一个错，定位 `line=3, col=1`，CLI 退出码 2 且 stdout 无部分 token。
- **D** `test_pop_empty_stack_fails` / `test_stack_depth_64_ok_65_fails`：
  pop 空栈失败；深度 64 成功、65 溢出失败。
- 另有 BOM 拒绝、非法 UTF-8、空匹配、捕获组禁止、最长匹配、token 字段等用例。

真实运行结果（Python 3.14.4，2026-10-01）：

```
Ran 15 tests in 0.355s

OK
```
