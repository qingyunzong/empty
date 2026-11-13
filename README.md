# 目录变更记录的折叠与操作序

目录采集调用可导入的Go包读取变更记录，不连接目录。续行以单个空格或制表符开始。双冒号的值要做base64解码，失败则该属性失败。变更类型只能是add、modify、delete。modify里的操作按顺序生效，删除不存在的值是错误，添加已存在的值也是错误。区分名用调用方的规范化函数比较。一条记录失败不能吞掉下一条。用独立目录模型核对折叠、重复加值和记录隔离，期望不得由被测包生成。

## 包接口

包名 `dataeng`，只有标准库依赖。

- `Parse` / `ParseChanges` / `Decode` 不传规范化函数时只解析记录；传入时解析并顺序应用。
- `ParseRecords` 始终只解析记录，不建立目录状态。
- `Decoder.Next` 逐条读取；坏记录通过 `Change.Err` 返回，下一次调用继续读下一条。
- `ReadChanges` 解析并顺序应用到内存目录，返回每条记录的结果。
- `Process` / `ApplyChangeLog` 与 `ReadChanges` 相同，并额外返回最终 `*Directory`。
- `Directory.Apply` 对单条记录原子应用；modify 内操作按给出的顺序执行。

`Change.Err` 可用 `errors.Is` 判断 `ErrInvalidBase64`、`ErrInvalidChangeType`、
`ErrValueExists`、`ErrValueNotFound` 等失败原因。属性名大小写不敏感，属性值按字节比较；
DN 只在调用方提供的 `normalizeDN` 下视为同一个名字，传 `nil` 表示按原文比较。

```go
changes, err := dataeng.ReadChanges(strings.NewReader(input), func(dn string) string {
	return strings.ToLower(strings.TrimSpace(dn))
})
if err != nil {
	return err // 仅表示输入/输出错误
}
for _, change := range changes {
	if change.Err != nil {
		log.Printf("record %d rejected: %v", change.Record, change.Err)
		continue
	}
	// change 已成功应用
}
```
