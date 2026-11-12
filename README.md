# 分条带栅格采集的目录与行编码

地理数据接入服务要从TIFF子集按矩形读取原始波段，请交付可导入Go库。文件头前两字节II或MM决定所有多字节数的端序，随后uint16固定42及uint32首IFD偏移；IFD为uint16项数、每项12字节(tag:uint16,type:uint16,count:uint32,valueOrOffset:uint32)，末尾uint32下一IFD偏移，0结束。类型仅BYTE=1、SHORT=3、LONG=4，数组总字节不超过4时值内嵌在valueOrOffset这4字节的前部，否则它是绝对文件偏移；未知tag可跳过但类型仍要认识，重复tag拒绝，目录链不能成环。必填256宽、257高、258每波段位宽、273条带偏移、279条带字节数；277波段数默认1、284平面布局默认1、278每条带行数默认高、259压缩默认1。所有样本8位无符号，258可一项统一或每波段一项且都为8；布局1按像素交错，布局2按波段分别存条带，条带数组按波段后条带顺序。宽高、波段数及每带行数均正。压缩1为原字节；32773为PackBits：有符号头n为0至127时复制后n+1字节，-1至-127时将下一字节重复1-n次，-128不产生字节；编码段不得让一个literal或run跨越解码行末，最后一条带可不足行数，解码长度必须恰为实际行数乘行字节数。原样本不做颜色、坐标或方向变换。读取接口选择IFD序号、非空矩形和波段列表，输出行主序且波段顺序按请求；先验证目录和本次涉及条带，坏条带不交付部分矩形，不读取无关条带数据。各标量tag必须count=1，数组tag只能SHORT/LONG（258只能SHORT），277/284/259也只能SHORT；请求波段从0编号，可重复并保留顺序，矩形须完全在图像内。未知tag的值仍验证字节范围但不物化。限制元数据数组总字节、目录项总数、条带解码字节及输出像素，所有偏移乘积检查溢出。用自编码双端序、多IFD夹具验证内嵌SHORT数组、平面波段顺序、部分末带、PackBits空操作与行边界、目录环及截断。

## tiff 子包

`tiff` 实现上述受限 TIFF 子集的只读访问，入口：

- `tiff.Open(path)` 或 `tiff.NewReader(r io.ReaderAt, size int64)` 解析头部与整条 IFD 链。
- `Reader.Images()` / `Reader.Image(i)` 按 IFD 序号选择目录。
- `Image.ReadRect(rect tiff.Rect, bands []int)` 返回行主序 `[]byte`，波段顺序按请求列表（可重复）。
- `tiff.NewReaderWithLimits` 与 `tiff.DefaultLimits` 控制元数据字节、目录项数、单条带解码字节与输出样本数上限。

解析期完成目录结构、tag 类型/count、重复 tag、IFD 环、偏移范围与全部条带几何校验；未知 tag 仅验证值区间不物化。`ReadRect` 只读取并解码与矩形/波段相交的条带，先整体验证涉及条带，任一坏条带返回错误且不产生部分输出。PackBits 解码强制行边界、识别 `-128` 空操作并校验精确解码长度。

测试使用包内自编码夹具覆盖双端序、多 IFD、内嵌/外部 SHORT 数组、两种平面布局、部分末带、PackBits 空操作/run/跨行拒绝、目录环、截断、重复 tag 与限制触发。

```go
r, err := tiff.Open("scene.tif")
if err != nil { /* ... */ }
defer r.Close()
im, err := r.Image(0)
if err != nil { /* ... */ }
samples, err := im.ReadRect(tiff.Rect{X: 10, Y: 20, Width: 64, Height: 48}, []int{2, 0})
```
