# XML namespace 事件规范化

异构数据入口可直接接入本包的事件流。解析器输出 namespace-expanded name、属性
前缀、原文档字节位置以及 `xml:base` 生效值：

```go
events, err := dataeng.Normalize(reader)
if err != nil {
    // 当前文档被拒绝
}
for _, ev := range events {
    if ev.Type == dataeng.StartElement {
        fmt.Println(ev.Name.Space, ev.Name.Local, ev.Pos)
    }
}
```

也可以使用流式接口：

```go
dec := dataeng.NewNormalizer(reader)
for {
    ev, err := dec.Next()
    if errors.Is(err, io.EOF) {
        break
    }
    if err != nil {
        return err
    }
    use(ev)
}
```

行为约定：

- 命名空间声明按元素作用域压栈/弹栈；重绑定只影响该元素的子树。
- 默认命名空间作用于元素，不作用于无前缀属性。
- 未声明前缀返回 `ErrUnboundPrefix`，整个 `Normalize` 调用不返回部分事件。
- 不展开 DTD 中声明的实体；五个预定义实体和数字字符引用可用，其他实体返回
  `ErrUnknownEntity`。
- `Event.BaseURI` 是解析后的生效基 URI，`Event.XMLBase` 是当前元素上的原始
  `xml:base` 值。
- `Position.Offset` 是零起始原文字节偏移，`Line`/`Column` 是一起始位置。
- 输入可以是 `io.Reader`、`string` 或 `[]byte`；读取方式与分块边界不影响事件。
