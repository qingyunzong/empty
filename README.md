插件宿主准备加载WebAssembly模块，需要可导入的Go模块检查包，处理版本1二进制的类型、导入、函数、导出、表和元素段，限定函数导入、funcref表与主动元素段，其他导入或元素形式拒绝；其他标准段只核对顺序与长度。调用方给允许的导入模块名、字段名和精确函数类型；逐项验证类型索引，导出函数索引须跨过导入函数计数，元素段中的函数引用须可达且符合表类型。自定义段可重复但不能干扰标准段排序，LEB128溢出和跨段长度必须拒绝。返回只读能力清单给加载器，未通过时不得调用实例化回调；用独立小模块编码器测试索引偏移、重复段及伪造导入签名。

## wasmcheck 子包

`wasmcheck` 实现上述 WebAssembly 版本 1 二进制检查器，入口为
`wasmcheck.Inspect`（只检查并返回只读能力清单）和 `wasmcheck.Load`
（检查通过后才调用实例化回调，失败时绝不回调）。

```go
caps, err := wasmcheck.Load(moduleBytes, []wasmcheck.AllowedImport{
    {
        Module:   "env",
        Field:    "increment",
        FuncType: wasmcheck.FuncType{Params: []byte{0x7f}, Results: []byte{0x7f}},
    },
}, func(caps *wasmcheck.Capabilities) error {
    // 仅在全部检查通过后执行实例化。
    return nil
})
```

校验要点：

- 仅接受函数导入、funcref 表、flags 为 0 或 2 的主动元素段；其他导入种类、
  表类型、被动/声明式元素段及表达式初始化元素段一律拒绝。
- 导入必须命中调用方给定的模块名、字段名与精确函数类型；类型索引逐项
  边界检查，导出函数索引必须跳过导入函数计数，元素段函数引用须可达。
- 标准段按规范顺序出现且不得重复；自定义段可重复、可位于任意位置。
- LEB128 截断、32 位溢出与非规范编码拒绝；段长度按声明边界隔离读取，
  载荷多余字节或跨段读取拒绝。
- `Capabilities` 字段不导出，访问器返回防御性副本，调用方无法篡改清单。

测试通过独立的最小模块编码器（`encoder_test.go`，与解析器无共享代码）
构造索引偏移、重复段、伪造导入签名等用例，`go test ./...` 运行。
