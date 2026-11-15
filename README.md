# Avro 解析 schema 引用闭包

事件解码服务需要可导入的 Go Avro schema 解析库，从 registry id 构建命名类型与引用闭包，处理 namespace、alias、union default 和递归记录。缓存按内容指纹隔离；引用版本变更不能污染旧解码。返回 writer-reader resolution 计划及首个不兼容路径。

## 用法

```go
reg := dataeng.NewMemoryRegistry()
reg.Register(dataeng.Schema{ID: 2, Version: 1, Raw: userSchema})
reg.Register(dataeng.Schema{
    ID: 1, Version: 1, Raw: eventSchema,
    References: []dataeng.Reference{{Name: "com.acme.User", ID: 2, Version: 1}},
})

c := dataeng.NewCompiler(reg)
writer, _ := c.Compile(1) // 命名类型闭包: writer.Names / writer.Refs
reader, _ := c.Compile(3)

plan, err := dataeng.Resolve(writer, reader)
if err != nil {
    if path, ok := dataeng.IncompatiblePath(err); ok {
        // 首个不兼容路径, 如 "$.sub.req"
        _ = path
    }
}
fmt.Println(plan) // match / promote / default / skip / enum-default 计划树
```

## 设计要点

- **编译与缓存**：`Compiler.Compile(id)` 递归编译引用闭包；指纹 = SHA-256(规范化 schema JSON + 各引用指纹)，内容相同必命中同一 `*CompiledSchema`，引用版本变更产生新条目，旧条目不受污染。
- **解析**：namespace 继承/显式覆盖/空串重置；类型 alias 解析为全名，字段 alias 保留原名；union default 按首分支校验；记录先注册名再解析字段以支持递归。
- **Resolution**：`Resolve(writer, reader)` 返回计划树（match/promote/default/skip/enum-default，含 union 分支与递归回边），失败时返回 `*IncompatibleError`，携带遍历顺序上的首个不兼容路径。
