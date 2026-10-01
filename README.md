# scoper

静态作用域解析器：输入解析后的 AST（JSON），输出每个 `use`/`assign` 的
绑定结果与闭包捕获列表。仅依赖 Python 3.11+ 标准库。

## CLI

```sh
python -m scoper src.scp --emit resolved.json   # 写入文件
python -m scoper src.scp                        # 输出到 stdout
```

- 成功：退出码 `0`，写出 `resolved.json`。
- 作用域错误：退出码 `5`，stderr 打印 JSON 错误，**不生成** `resolved.json`。
- 输入文件缺失/非法 JSON/非法 AST：退出码 `2`。

## 输入 AST 格式

顶层为一个 `block`（或语句列表）。节点类型共六种，`span` 为可选的
`[start, end]` 偏移对：

```json
{"type": "block",  "stmts": [...]}
{"type": "let",    "name": "x", "span": [0, 1]}
{"type": "const",  "name": "x", "span": [0, 1]}
{"type": "fn",     "name": "f", "params": ["a"], "body": {"type": "block", "stmts": []}}
{"type": "use",    "name": "x", "span": [2, 3]}
{"type": "assign", "name": "x", "span": [4, 5]}
```

## 语义

1. 全局名与函数参数在进入其作用域时绑定（参数无 TDZ）。
2. `let`/`const` 在块入口提升（hoist）到本块作用域，但在其声明语句执行
   前处于 TDZ；`fn` 名在块起始即可解析，但其**函数体延迟到 `fn` 语句
   处**才处理（因此 `fn f(){use x} let x` 报 TDZ，而
   `fn f(){use g} fn g(){}` 可解析）。
3. `use` 解析到最近可见绑定；未命中任何作用域时回退到内建名
   （`print`、`len` 等，见 `scoper.BUILTINS`），否则报 `Undefined`。
   `assign` 规则相同，且目标为 `const` 时报 `AssignConst`；对内建名
   赋值视为 `Undefined`。
4. 同一块内重复声明（含 `fn` 与 `let` 冲突、重复参数）报 `Duplicate`；
   内层块可遮蔽外层同名绑定。
5. 所有错误均为 `ScopeError`，含 `name, kind, use_span, def_span`
   （`kind ∈ {Undefined, Duplicate, TDZ, AssignConst}`）。

## 输出 resolved.json

```json
{
  "defs":     [{"id": 0, "name": "x", "kind": "let|const|fn|param", "span": [0, 1]}],
  "uses":     [{"name": "x", "span": [2, 3], "def_id": 0},
               {"name": "print", "span": [4, 5], "builtin": true}],
  "assigns":  [{"name": "x", "span": [6, 7], "def_id": 0}],
  "captures": {"<fn_def_id>": ["按 def_id 升序排列的被捕获 def_id"]}
}
```

`def_id` 按定义创建顺序分配（块提升按语句顺序，参数在函数体之前）。
捕获是传递的：内层函数体里解析到外层作用域的 `use`/`assign`，会记入
路径上每一个函数边界的捕获列表。

## 测试

```sh
python -m unittest discover -s tests -v
```

- `tests/test_scoper.py`：验收用例 B/C/D 与语义单测。
- `tests/test_reference.py`：随机小作用域树生成器 + 独立的环境栈
  参考实现，300 个种子逐例比对（错误四元组与完整输出均一致）。
- `tests/test_cli.py`：子进程跑真实 CLI，校验退出码与文件行为。

## 真实运行记录

`python -m unittest discover -s tests -v`（Python 3.14.4，2026-10-01）：

```
test_scope_error_exit_5_and_no_output (test_cli.TestCli...) ... ok
test_stdout_when_no_emit (test_cli.TestCli...) ... ok
test_success_emits_resolved_json (test_cli.TestCli...) ... ok
test_300_random_trees_match_reference (test_reference.TestDifferential...) ... ok
test_b_inner_use_before_let_is_tdz (test_scoper.TestAcceptance...) ... ok
test_c_mutual_fn_deferred_bodies_and_capture (test_scoper.TestAcceptance...) ... ok
test_d_assign_const_fails (test_scoper.TestAcceptance...) ... ok
test_d_duplicate_let_same_block_fails (test_scoper.TestAcceptance...) ... ok
test_assign_builtin_is_undefined (test_scoper.TestSemantics...) ... ok
test_assign_let_ok (test_scoper.TestSemantics...) ... ok
test_assign_tdz (test_scoper.TestSemantics...) ... ok
test_builtin (test_scoper.TestSemantics...) ... ok
test_duplicate_param_fails (test_scoper.TestSemantics...) ... ok
test_fn_body_deferred_let_still_in_tdz (test_scoper.TestSemantics...) ... ok
test_fn_body_sees_earlier_let (test_scoper.TestSemantics...) ... ok
test_fn_hoisted_before_its_statement (test_scoper.TestSemantics...) ... ok
test_nested_capture_transitive_and_sorted (test_scoper.TestSemantics...) ... ok
test_params_bound_at_entry_and_shadowable (test_scoper.TestSemantics...) ... ok
test_shadowing_across_blocks_ok (test_scoper.TestSemantics...) ... ok
test_shadowing_uses_nearest_binding (test_scoper.TestSemantics...) ... ok
test_top_level_list_accepted (test_scoper.TestSemantics...) ... ok
test_undefined (test_scoper.TestSemantics...) ... ok
----------------------------------------------------------------------
Ran 22 tests in 1.323s

OK
```

CLI 实测（成功）：`python -m scoper src.scp --emit resolved.json`，
退出码 `0`，`resolved.json` 中 `bump` 体内 `use total` 解析为
`"def_id": 1`，`use print` 为 `"builtin": true`，
`"captures": {"2": [1]}`。

CLI 实测（TDZ 失败）：对内层 `{use x; let x}` 输入，退出码 `5`，
stderr 输出：

```json
{
  "error": "ScopeError",
  "name": "x",
  "kind": "TDZ",
  "use_span": [10, 11],
  "def_span": [20, 26]
}
```

且 `resolved.json` 未生成。
