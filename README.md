# 嵌套列表的重复级别与定义级别

## 语义

- 行类型：可空 `list<可空 list<可空 int64>>`，对应 `Row{Outer *[][]*int64}`；nil 与空切片在每一层都严格区分。
- 定义级 `d`：`0` 外 list 为 null，`1` 外 list 空，`2` 外元素（内 list）为 null，`3` 内 list 空，`4` 内元素（叶）为 null，`5` 叶有值；仅 `d=5` 携带 `Value`。
- 重复级 `r`：`0` 开新行，`1` 开同一行的下一个外元素，`2` 续同一内 list。
- 续接规则：`r=1` 要求相邻两 token 的 `d` 均不小于 2；`r=2` 要求均不小于 4；首 token 必须 `r=0`。`r∈[0,2]`，`d∈[0,5]`。
- 行数参数非负，且只在 `Finalize`（流结束）时与实际 `r=0` 数核对；空流仅在期望 0 行时合法。

## 主要 API

- `EncodeRows([]Row) []Token`：树结构按层级编码为 token 流，叶值复制后携带，保留每个叶值 token 的相对位置。
- `LevelValidator` / `ValidateTokenStream`：独立逐 token 状态机，跨批保留状态，核验范围、首 token、续接、值规则与最终行数。
- `Decoder`：`NewDecoder(wantRows)`、`DecodeBatch(batch)`、`Finalize()`。
  - 每个批次原子校验：批次内任一 token 非法时，该批次完成的行一律不发布，状态快照回滚。
  - 之前批次已发布的行保留；最后一个未完成行暂存在解码器中，由后续批次续接或由 `Finalize` 确认。

## 测试

`go test ./...` 覆盖六种定义级、复杂行往返、叶值位置、null/空不混同、14 类非法流、空流、所有切点的跨批解码、失败批次回滚后重试，以及 800 组随机树的整流/随机分批往返。
