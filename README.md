# 列式变长缓冲区的零拷贝切片

内存分析引擎调用可导入的Go变长列包，列由字节缓冲、非降偏移数组和有效性位图组成，偏移数为行数加一且不越界，null行仍允许非空物理区间。调用方以所有权转移方式交出缓冲，之后不再修改；切片可零拷贝持有原缓冲，拼接须把有效行紧凑重排，null区间不复制；对外读取不得暴露能修改共享底层的字节切片。支持显式引用释放，最后持有者释放后调用回收器恰一次，关闭后访问报错。测试重叠切片、空值非空区间、并发释放和输入校验。

## varcol 包

可导入包位于 `varcol/`（导入路径 `example.org/dataeng/q0083/varcol`）。

- `varcol.New(data, offsets, validity, rows, recycler)`：所有权转移式构造，做完整输入校验。
- `(*Column).Slice(start, end)`：零拷贝切片，共享底层并增加引用计数，切片允许重叠。
- `varcol.Concat(cols, recycler)`：仅复制有效行字节并紧凑重排，null 行物理区间不复制。
- `Get` / `AppendValue` / `WriteValueTo`：只读访问，不返回可修改共享底层的字节切片。
- `(*Column).Release()`：显式释放；最后一个持有者释放时回收器恰好调用一次，释放后访问返回 `ErrClosed`。

运行测试：

```sh
go test -race ./varcol/
```
