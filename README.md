# Avro schema resolution 精确默认值

消息入口需要可直接接入的 Go Avro schema resolution 组件，执行 writer/reader record、union、alias、numeric promotion 和默认值规则。默认值按 reader schema 类型解释，union 分支不得按名称猜测；递归 schema 用引用图避免无限展开。官方兼容样例与小 schema 穷举核对。

## 使用

```go
writer, err := dataeng.ParseSchemaString(writerJSON)
reader, err := dataeng.ParseSchemaString(readerJSON)
resolver, err := dataeng.NewResolver(writer, reader) // 一次编译，可并发复用
datum, err := resolver.ResolveJSON(messageJSON)     // 消息入口
```

也提供 `NewHandler` / `NewHandlerFromJSON` 作为消息入口适配器，以及
`Compatible` / `CheckCompatibility` 做 schema 兼容性判断。

## 表示约定

- `int` → `int32`，`long` → `int64`，`float` → `float32`，`double` → `float64`
- `bytes` / `fixed` → `[]byte`，`enum` → `string`
- record → `map[string]any`，array → `[]any`，map → `map[string]any`
- union → `dataeng.UnionValue{Index, Value}`；writer union 输入必须显式给出分支索引

默认值只按 reader schema 解释；union 字段默认值必须匹配第一个分支，不会按
名称或值形状扫描其他分支。命名类型在解析时复用同一个 `*Schema` 指针，解析
计划按 `(writer, reader)` 对记忆化，因此递归 schema 不会无限展开。

## 测试

```sh
go test ./...
```

测试包含 Avro 规范中的兼容样例、primitive/union 小 schema 穷举矩阵、别名与
默认值案例，以及递归 schema 解析与转换。
