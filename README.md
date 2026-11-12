# 旧表格共享串的续记录宽度切换

旧表格采集器已经拆好BIFF记录，需要Go可导入的SST字符串读取包，不能先把SST与CONTINUE载荷直接拼接，因为字符串续段开头可能插入编码标志。输入非空载荷片段列表，第一片类型SST，其余CONTINUE；首片前8字节是little-endian uint32总引用数total及唯一串数unique，须total>=unique，首片不足8字节拒绝。随后恰有unique个字符串：uint16的UTF16单元数cch、uint8 flags，仅允许位0表示双字节、位2表示扩展尾、位3表示富文本；有位3再跟uint16 cRun，有位2再跟int32 cbExt且须非负，顺序固定，整个字符串固定头不得跨片段。字符数据先按位0选择每单元1字节或little-endian 2字节，单字节直接扩展成U+00xx而不是UTF8。当且仅当一个字符串还有字符单元未读、需要进入下个片段继续字符数据时，新片段首字节必须为0或1，替换该字符串当前字符宽度，不计入cch；在固定头、富文本run、扩展尾或两字符串之间跨片段不读取这种标志。双字节单元不可被片段边界截断，但高低代理单元可分别位于不同片段，甚至续段换宽后才发现非法代理组合；完成整个字符序列后严格核验UTF16成对代理，拒绝孤立代理。若字符串字符数据恰在旧片段末尾结束，则新片段从run或扩展尾或下一串开始，不能吞首字节作为宽度标志。字符后有cRun个四字节run，每个由uint16起始单元位置及uint16字体号组成，run字节可任意跨片段；若有run则cch>0、第一位置0、其后严格递增且小于cch，位置不能切断代理对。最后cbExt字节是原样保留的扩展数据，可任意跨片段，不解析其内部。不允许空载荷片段，进入字符续片后若只有宽度标志而仍无字符应拒绝；固定头若在片末结束且cch>0，下一片按字符续片规则读取标志。所有声明计数及乘法在分配前与宿主上限比较，唯一串读完后须恰好耗尽所有载荷，不把多余字节忽略为填充。成功一次返回按索引排列的文本、run、扩展字节及每个UTF16单元的原片段/字节来源，失败不发布半张表，也不把total当需要解码的字符串数。提供采集器调用例和独立编码夹具测试，覆盖单串多次宽度切换、字符边界和run边界各自的续片、零长串后跟新头、跨片代理对、扩展尾首字节0或1以及声明数超限；不解析OLE容器、公式或工作表XML。

## Go API

```go
table, err := dataeng.ReadSST([]dataeng.Fragment{
    dataeng.NewSSTFragment(sstRecordPayload),
    dataeng.NewContinueFragment(continueRecordPayload),
})
```

`ReadSST` either returns the complete table or `(nil, error)`. `Table.Strings`
is ordered by string index; each `SSTString` contains `Text`, `Units`, `Runs`
and the uninterpreted `Ext` bytes. `Unit.Fragment`, `Unit.Offset` and
`Unit.Size` locate each original UTF-16 unit in the supplied fragment payloads.
See `example_test.go` for a collector handoff with a width-switching
continuation.
