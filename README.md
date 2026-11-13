# 内部实体展开上限与默认命名空间

文档采集调用可导入的Go包读取片段，不访问外部资源。外部实体一律拒绝。内部实体展开后的总长度受调用方上限约束，超限失败。默认命名空间只作用到当前元素结束，不落到后面的兄弟。未声明的前缀失败。用小片段核对外部实体、展开上限和默认命名空间，期望不得由被测包生成。

## 使用

```go
import "example.org/dataeng13/q0077"

fragment, err := dataeng.ParseFragment(src, 4096)
// 也可以使用 dataeng.ReadFragment(reader, 4096)
```

`maxExpandedBytes` 限制整个片段中内部实体展开产生的字节总数，必须非负；超过上限时错误可用
`errors.Is(err, dataeng.ErrExpansionLimit)` 判断。外部实体和外部 DTD 子集返回
`ErrExternalEntity`，未声明前缀返回 `ErrUndeclaredPrefix`。

解析结果是 `*dataeng.Fragment`，`Elements` 取顶层元素，`Root` 取首个顶层元素，
`Node.TextContent` 取元素内文本。`Node.Name` 和 `Attr.Name` 中的 `Space` 是解析后的命名空间 URI。

实现只使用 Go 标准库，不打开文件、不访问网络，也不解析外部 DTD。内部通用实体按文本展开；
参数实体、条件 DTD 段以及实体值中的标记不在此片段读取器的支持范围内。
