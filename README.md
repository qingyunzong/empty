# aggql

一个基于 JSON 的迷你聚合查询引擎（Python 3.11+ 标准库，无第三方依赖）。

## 用法

```sh
python -m aggql query.json rows.json
```

- `rows.json`：JSON 数组，每个元素是一个对象（一行）。
- `query.json`：查询定义（见下）。
- 结果以 JSON 数组输出到 stdout；输入/查询错误（含未知聚合列）退出码为 2。

## 查询格式

```json
{
  "group_by": ["dept"],
  "aggregates": [
    {"func": "COUNT", "arg": "*", "as": "cnt"},
    {"func": "SUM", "arg": "salary", "distinct": true, "as": "total"},
    {"func": "AVG", "arg": "salary", "as": "avg"}
  ],
  "having": {"op": "GT", "left": {"alias": "cnt"}, "right": {"const": 2}}
}
```

- `func`：`COUNT` / `SUM` / `AVG` / `MIN` / `MAX`；`arg` 为列名，`*` 仅用于 `COUNT`。
- `distinct`（可选）：聚合前去重；`as`（可选）：输出列名。
- 无 `group_by` 时整个输入为一组；空输入且分组键无法校验时跳过列校验。

## 语义

1. `COUNT(*)` 计输入行数；`COUNT(col)` 忽略 NULL；`SUM/AVG/MIN/MAX` 均忽略 NULL。
2. `GROUP BY` 中 NULL 自成一组；`DISTINCT` 去重时所有 NULL 视为相同。
3. `AVG` 输出最简分数字符串（如 `3/2`，整数为 `n/1`）；空集 `COUNT=0`，
   `SUM/MIN/MAX/AVG=NULL`。
4. `HAVING` 使用三值逻辑（TRUE/FALSE/UNKNOWN），只保留 TRUE 的组；
   与 NULL 比较得到 UNKNOWN。未知聚合列退出码 2。

## HAVING 表达式

- 逻辑：`{"op": "AND"|"OR", "args": [...]}`、`{"op": "NOT", "arg": ...}`
- 比较：`{"op": "EQ"|"NE"|"LT"|"LE"|"GT"|"GE", "left": <操作数>, "right": <操作数>}`
- 空值：`{"op": "IS_NULL"|"IS_NOT_NULL", "arg": <操作数>}`
- 操作数：`{"const": v}`、`{"alias": "聚合列名"}`、`{"col": "分组列名"}`、
  `{"agg": {"func": ..., "arg": ...}}`

## 测试

```sh
python -m unittest discover -s tests -v
```

测试包含独立排序与字典重算的参考实现对照（`tests/test_aggql.py`）。
