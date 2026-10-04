# cfg — 支持段继承与字段插值的配置库

纯 Go 标准库实现，无第三方依赖。

## 配置格式

INI 风格，`inherit` 为保留指令（可列多个父段，逗号分隔），字段值中
`${field}` 引用本段字段，`${section.field}` 引用其他段字段：

```ini
[base]
root = /srv/base
data = ${root}/data

[child]
inherit = base
root = /srv/child
```

## 语义

1. **先继承，再本段覆盖**：父段按列出顺序合并（后列出的父段覆盖先列出的），
   本段自有字段最后应用，优先级最高。菱形继承中共同祖先的字段只合并一次。
2. **插值按最终字段展开**：继承合并完成后才做插值，因此继承来的
   `${root}/data` 在子段中展开时使用子段覆盖后的 `root`
   （上例中 `child.data = /srv/child/data`）。
3. **继承环检测**：DFS 检测，报错带完整路径，如
   `inheritance cycle detected: a -> c -> b -> a`。
4. **字段环检测**：插值展开栈检测，报错带完整路径，如
   `interpolation cycle detected: s.a -> s.b -> s.a`。
5. **缺失引用失败**：继承不存在的段、引用不存在的段或字段均返回
   `MissingError`，CLI 以退出码 1 失败。

## 菱形继承：扁平模型 vs 逐字段递归模型

以 `examples/diamond.ini` 为例（d 继承 b、c，b/c 继承 a；b 定义
`path = ${root}/b`，d 覆盖 `root = /d`）：

| 模型 | 解析方式 | `d.path` |
|---|---|---|
| 扁平模型（本库 `Resolve`，默认） | 先把继承压平成最终字段表，再在使用方段的最终字段上下文中展开插值 | `/d/b` |
| 逐字段递归模型（`ResolveRecursive`，对照用） | 每个字段在使用时沿继承链递归查找定义者，插值在**定义方**段的上下文中展开 | `/a/b` |

- 纯值字段（无插值）在两种模型下结果一致；
- 只有含插值的继承字段会分叉：差异在于 `${root}` 在「使用方最终字段」
  还是「定义方上下文字段」中展开；
- `Config.CompareModels` 返回两模型所有不一致字段，`cfg compare` 直接展示。

## CLI

```sh
go build -o cfg ./cmd/cfg
cfg get     examples/diamond.ini d path   # 打印最终值 -> /d/b
cfg dump    examples/diamond.ini [d]      # 打印解析后的段
cfg trace   examples/diamond.ini d path   # 来源追踪：定义链 + 插值来源树
cfg compare examples/diamond.ini          # 扁平 vs 逐字段递归模型对照
```

`cfg trace` 输出示例：

```
d.path = /d/b
definitions (lowest precedence first, * = winner):
  * [b] path = ${root}/b
interpolation sources:
  d.root = /d (defined in [d])
```

## API 概览

- `Parse` / `ParseFile` → `*Config`
- `(*Config).Resolve()` — 扁平模型解析（继承合并 + 最终字段插值）
- `(*Config).ResolveRecursive()` — 逐字段递归模型（对照）
- `(*Config).CompareModels()` — 两模型差异列表
- `(*Config).TraceField(section, field)` — 来源追踪（定义链 + 插值来源树）
- 错误类型：`CycleError{Kind, Path}`、`MissingError`

## 测试结果

`go test ./...` 实际运行结果（go1.27.1 linux/amd64）：

```
ok  	cfg	0.003s
?   	cfg/cmd/cfg	[no test files]
```

共 15 个测试，覆盖：继承覆盖顺序、多父优先级、菱形合并、继承环路径、
缺失父段、最终字段插值、跨段引用、字段环路径、缺失引用、来源追踪、
菱形两模型对照、递归模型的环检测。
