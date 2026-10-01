# bmc — 整数迁移系统有界模型检测器

`bmc` 是一个纯标准库（Python 3.11+）实现的 BFS 有界模型检测器。

## 用法

```sh
python -m bmc check model.json --bound 12 --out trace.json
```

- 结果 JSON 打印到 stdout，并同时写入 `--out` 指定的文件。
- 退出码：`0` = 检查完成（`VIOLATION` 或 `SAFE_BOUNDED`）；`1` = 运行时错误（如 `E_READ`）；`2` = 模型/输入非法（stderr 输出一行 JSON）。

## 模型格式

```json
{
  "variables": ["x", "y"],
  "init": {"x": 0},
  "transitions": [
    {"name": "inc", "guard": "x < 9", "assign": {"x": "x + 1"}}
  ],
  "invariant": "x >= 0"
}
```

- `variables`：可选，至多 6 个；缺省时取 `init` 键与赋值目标的并集。已声明但未被 `init` 赋值的变量初始为**未定义**。
- `init`：必填，初值须为 `[-9, 9]` 内整数。
- `transitions`：必填列表，至多 40 条；`guard` 为表达式字符串，`assign` 为同时（simultaneous）赋值。
- `invariant`：可选，默认为 `"True"`。
- 表达式支持 `+ - * // %`、比较、`and/or/not`、一元 `-/not`，仅整数与布尔常量；使用 AST 白名单求值，不调用 `eval`。

## 语义

1. 状态按变量名排序规范化；读取未定义变量产生错误 `E_READ`。
2. 迁移仅当 guard 为真且赋值后所有值仍在 `[-9, 9]` 内才启用，否则该迁移被**禁用**而非崩溃。
3. 按 BFS 层序探索，发现 invariant 为假即输出当前最短路径。
4. 到达 bound 未见违例返回 `SAFE_BOUNDED`，绝不声称全局安全。
5. 同一状态不重复入队（按规范化状态去重）。

## 输出格式

```json
{
  "status": "VIOLATION | SAFE_BOUNDED | ERROR",
  "depth": 2,
  "visited": 7,
  "trace": [{"x": 0}, {"x": 1}],
  "counterexample": {"transitions": ["inc"], "states": [{"x": 0}, {"x": 1}]},
  "error": null
}
```

- `trace`：从初始状态到违例状态的最短状态序列（无违例时为 `[]`）。
- `counterexample`：违例时的迁移名序列与状态序列，否则为 `null`。
- `error`：`{"code": "E_READ" | "E_EVAL", "message": ...}` 或 `null`。

## 测试

```sh
python -m unittest discover -s tests -v
```

验收覆盖：A 三进程互斥违反且深度等于独立枚举 BFS 最短深度；B 值域越界迁移被禁用不报错；C 环模型 bound 内 `SAFE_BOUNDED` 且 visited 等于手工枚举；D 非法 JSON/模型 exit 2 且 stderr 为一行 JSON。
