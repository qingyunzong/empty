# 固定卡片数组中的缺失值与精确缩放

天文归档接入服务要导入FITS整数图像，要求一个可导入的Go读取包。这里只接收单个主HDU：头由80字节ASCII卡组成，前8字节是右侧空格补齐的关键字，普通卡第9至10字节为等号和空格，值在余下部分，斜杠起注释；本题值只含带可选正负号的十进制整数、有限十进制小数或T/F，不支持指数形式，不含字符串。END卡第9字节起全为空格，END后到2880字节边界全为空格，随后是数据，末尾以零补齐到2880边界，不允许第二HDU或尾杂字节。必填SIMPLE=T、BITPIX取8/16/32/64、NAXIS及依次NAXIS1..NAXISn，NAXIS为0至8，普通卡可任意排列；关键字不得重复；NAXIS=0表示无数据，其他维长度可为0，首维最快。8位样本无符号，其他为有符号大端。BLANK可选且必须在原始类型范围内，样本原值等于BLANK时返回missing，不对它缩放；其余返回BZERO+BSCALE*raw的规范有理数，默认分别0和1，不得经float64损失64位整数。读取包接受ReaderAt与文件长度，提供多维半开矩形读取，返回坐标、原值、missing及物理值；一次请求越界、头数据截断或填充错误时整次拒绝，不静默忽略。未知关键字可保留但不能改变读取语义，限制头卡数与输出像素数，超限明确返回资源错误。交付测试，以独立构造的字节夹具核对跨2880头块、BLANK在缩放前判断、负BSCALE、零维、int64极值及连续读取相邻区域的对应关系。

## 使用

```go
f, err := os.Open("image.fits")
if err != nil {
	// handle error
}
defer f.Close()

info, err := f.Stat()
if err != nil {
	// handle error
}

image, err := dataeng.Open(f, info.Size(), dataeng.WithMaxOutputPixels(1<<20))
if err != nil {
	// errors.Is(err, dataeng.ErrInvalidHeader) 等
}

samples, err := image.ReadRect(
	[]int64{10, 20}, // 含起点
	[]int64{20, 30}, // 不含终点
)
```

每个 `Sample` 包含 `Coord`、原始整数 `Raw`、`Missing` 和 `Physical`。`Physical` 是 `*big.Rat`，缺失样本时为 `nil`；非缺失值严格按 `BZERO + BSCALE*Raw` 计算，不经过浮点数。

## 严格性与限制

- 仅支持单个主 HDU；文件长度必须恰好覆盖头、数据和零填充。
- 头卡只能是 ASCII、值只能是整数/有限十进制小数/T/F；END 后和 2880 字节头块尾部必须全为空格。
- 重复关键字、缺失或多出的 `NAXISn`、非法 `BLANK`、指数记号和字符串值均拒绝。
- 任意一次矩形读取先完整校验边界和像素数，再读取；越界、短路读取或资源超限返回错误且不返回部分样本。
- 默认头卡上限为 1024，单次输出像素上限为 `1<<20`，可通过 `WithMaxHeaderCards` 和 `WithMaxOutputPixels` 调整。超限错误可用 `errors.Is(err, dataeng.ErrResourceLimit)` 判断。

测试夹具由测试代码直接拼接 80 字节卡片、2880 字节块和大端样本，不依赖生产解析路径：

```sh
go test ./...
```
