# utf8fix

将字节流修复为合法 UTF-8：每个非法字节替换为一个 U+FFFD，合法序列原样保留，
并输出原字节偏移与修复后码点索引的双向位置映射。

## 库

```go
f := utf8fix.NewFixer()
f.Write(chunk1) // 跨块尾部的不完整序列会被挂起，不提前判断
f.Write(chunk2)
f.Flush()
out := f.Drain()
m := f.Mapping() // m.ByteToRune[字节偏移]=码点索引；m.RuneToByte[码点索引]=字节偏移
```

## CLI

```
utf8fix [-chunk N] [-map FILE|-] [input-file]
```

- 输入默认为 stdin，修复结果写 stdout。
- `-map FILE` 将 `{byteToRune, runeToByte}` 映射以 JSON 写出；`-map -` 写 stderr。
- `-chunk N` 控制读取块大小，结果与切块无关。

## 测试

```
go test ./...
```

测试对每个语料枚举全部 2^(n-1) 种切块（含非法前后缀、截断序列、超长编码、
代理区码点等），断言流式输出与映射和一次性参考实现完全一致，并核验双向映射
不变量（每个替代符恰好对应一个非法字节，合法序列逐字节对齐）。
