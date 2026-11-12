# 采集控件的跨块字素边界

RPA输入宿主按用户可见字符移动光标，不能把emoji连接序列或旗帜拆开。请交付可导入的Go分段包，接收分块UTF-8和注入的码点属性查询器，输出每个已闭合字素的原始字节区间、UTF-16区间和文本。查询器返回一个类别CR/LF/Control/L/V/T/LV/LVT/Extend/ZWJ/SpacingMark/Prepend/RI/Other，以及独立的ExtendedPictographic布尔标志。本题只要求以下按顺序决策的边界规则：全文起点和终点是边界，空输入零簇；CR与LF不分；Control、CR、LF两侧分，前条优先；L后接L/V/LV/LVT不分，LV或V后接V/T不分，LVT或T后接T不分；任意字符与后接Extend或ZWJ不分，与后接SpacingMark不分，Prepend与其后字符不分；ExtendedPictographic后跟零或多个Extend再跟ZWJ且下一码点为ExtendedPictographic时不分；连续RI中从段首计数，两个RI之间仅当前面的连续RI数量为奇数时不分；其余都分。所有判断跨输入块保留状态，不把当前块结尾当边界，显式finish才封口最后簇；非法UTF-8和截断给首个错误字节位置，已交付前缀不撤回但当前未封口簇不得交付。回调成功才算已交付，回调失败终止且不再接收输入。调用方设正整数单簇最大字节数，超过即资源错误并停止，不能强制切簇冒充成功。另提供从有效分段结果把任意UTF-16光标位置向左或向右贴到合法簇边界的接口，范围外拒绝，落在代理对中间也按整个簇处理。测试使用人工属性表，无需下载Unicode库，逐一枚举切块位置与独立整串规则参考核对CRLF、Hangul、组合附加符、三或五个RI、emoji Extend ZWJ及跨块无效编码；说明这里只实现给定规则子集。

## 用法

包路径为 `example.org/dataeng/q0265`，Go 包名为 `dataeng`。属性类别和
`ExtendedPictographic` 标志由调用方注入；实现不读取 Unicode 数据表，并且
**只实现上面列出的规则子集**，不是完整的 Unicode 字素算法。

```go
segmenter, err := dataeng.NewSegmenter(dataeng.Options{
	Lookup:          lookup, // func(rune) dataeng.Properties
	MaxClusterBytes: 4096,
	Emit: func(g dataeng.Grapheme) error {
		// g.ByteStart/g.ByteEnd 与 g.UTF16Start/g.UTF16End 都是
		// 整个输入流上的半开区间；g.Text 是原始 UTF-8 文本。
		return nil
	},
})
if err != nil {
	return err
}
for _, chunk := range chunks {
	if err := segmenter.Feed(chunk); err != nil {
		return err
	}
}
if err := segmenter.Finish(); err != nil {
	return err
}
```

`Feed` 的块尾不是字素边界；只有 `Finish` 应用全文终点边界。编码错误和资源
错误都可用 `errors.As` 取得位置或超限详情，并会永久停止分段器。回调返回错误
同样会永久停止分段器，失败的簇不算已交付。

UTF-16 光标吸附可复用边界表：

```go
cursorMap, err := dataeng.NewUTF16CursorMap(clusters)
if err != nil {
	return err // 分段结果不连续或文本区间不一致
}
left, err := cursorMap.SnapLeft(position)
right, err := cursorMap.SnapRight(position)
```

位置超出 `[0, cursorMap.Length()]` 会返回 `ErrCursorOutOfRange`；落在代理对
中间或任意簇内部时，向左吸附到簇首，向右吸附到簇尾。
