# cfglib — 支持段继承与字段插值的配置库（仅 Go 标准库）

## 语义

- **段继承**：段内保留字 `extends = p1, p2` 声明父段（可多继承）。
  解析顺序为**先继承、后本段覆盖**：父段按声明顺序合并（先列出的父段
  其整棵子树优先），本段字段最后覆盖所有继承值。
- **字段插值**：`${key}` 引用同段字段，`${sec.key}` 引用他段字段；
  插值在继承合并完成后，按**最终字段**递归展开（子段覆盖的字段会
  影响从父段继承来的插值结果）。
- **环检测**：继承环与插值环分别报错并给出路径，如
  `inheritance cycle detected: a -> b -> c -> a`、
  `interpolation cycle detected: sec.a -> sec.b -> sec.a`。
- **缺失引用**：引用不存在的段或字段时返回 `missing reference: sec.key`。

## 两种解析模型对照

- 合并模型 `(*Config).Resolve`：整段记忆化合并，菱形继承中公共祖先
  只解析一次。
- 逐字段递归模型 `(*Config).LookupField`：按字段沿 extends 链深度优先
  查找。
- `(*Resolved).CompareModels` 对全部字段逐一核对两种模型的取值与来源，
  `cfgtrace compare` 命令输出对照结果。

## CLI

```
go build -o cfgtrace ./cmd/cfgtrace
cfgtrace get     <file> <section> <key>   # 打印插值后的最终值
cfgtrace trace   <file> <section> <key>   # 来源追踪：定义位置、继承链、插值展开树
cfgtrace list    <file>                   # 列出所有段的解析字段及来源
cfgtrace compare <file>                   # 合并模型 vs 逐字段模型对照
```

示例见 `examples/app.ini`（菱形继承：app -> {auth, billing} -> base）。

## 测试

```
go test ./...
```
