# logimport

流式日志导入库（仅 Go 标准库）与命令行工具。

## 语义

- **记录**由一条起始行和随后若干续行组成，由有限规则表（`[]logparse.Rule`）判定；
  内置规则见 `logparse.DefaultRules()`（时间戳起始行、`[LEVEL]` 起始行，缩进行为续行）。
- **孤立续行**（前面没有起始行的续行）产生 `DiagOrphanContinuation` 诊断并丢弃该行。
- **长度超限**（`-max-line-length` / `Options.MaxLineLength`，按字节、不含换行符）：
  闭合当前记录后进入丢弃状态，直到下一条未超限的起始行；整段被丢弃的字节范围
  以一条 `DiagLineTooLong` 诊断保留（`[Start, End)` 精确对应输入字节）。
- **末行可无换行符**：`Close` 时残余字节按最后一行处理；兼容 CRLF。
- 既不匹配起始也不匹配续行的普通行成为单行普通记录（`Rule == ""`），不为续行提供锚点。

## 任意字节切块

`Parser.Write` 接受任意大小的字节块，记录与诊断的输出与切块方式无关。
测试以块大小 1/2/3/5/7/13/64、整体喂入及 20 组固定种子伪随机切块分别解析同一输入，
用 `reflect.DeepEqual` 断言输出完全一致。CLI 的 `-chunk-size` 仅改变喂入方式。

## 用法

```go
p := logparse.NewParser(
    logparse.Options{Rules: logparse.DefaultRules(), MaxLineLength: 4096},
    func(r logparse.Record) { /* ... */ },
    func(d logparse.Diagnostic) { /* ... */ },
)
p.Write(chunk) // 可多次
p.Close()
```

CLI：

```sh
go run ./cmd/logimport [-max-line-length N] [-chunk-size N] [-json] [文件...]
# 无文件参数时读标准输入；输出按字节偏移排序的记录与诊断
```

## 测试结果

`go test ./...`（go1.27.1 linux/amd64，2026-10-05 实际运行）：

```
?   	logimport/cmd/logimport	[no test files]
ok  	logimport/logparse	0.017s
```

11 个测试全部通过，覆盖：起始/续行组记录、孤立续行诊断、普通行后续行判孤立、
超限丢弃与错误范围（含超限行本身为起始行、丢弃延伸至 EOF）、末行无换行、
空输入与空行、CRLF、级别规则、恰好在长度上限的边界行，以及上述所有用例的
任意切块一致性。
