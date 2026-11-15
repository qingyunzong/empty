# HL7 批次封套与转义解析

零依赖的 Go HL7 v2 批次解析库，包名为 `dataeng`。

## 能力

- 每个 `MSH` 独立读取 `MSH-1`/`MSH-2`，支持自定义分隔符。
- 字段树保留 `重复字段 -> 组件 -> 子组件` 的原始文本和解码文本。
- 解码 `\F\`、`\S\`、`\R\`、`\T\`、`\E\`、`\X...\` 等转义；未知转义原样保留，未闭合转义报错。
- 支持 `FHS/BHS`、`FTS/BTS`，并保留 `BTS-1`、`FTS-1` 声明的计数证据。
- 单条消息失败不会把 `BTS-1` 的声明值改成成功消息数；`ObservedMessages`、`ValidMessages`、`FailedMessages` 分开统计。
- 封套截断、缺少 `BTS`/`FTS` 或计数不一致时返回 `nil` 批次，不发布部分结果。
- 错误带原始行号、字节偏移、段 ID、`MessageSegmentIndex`、原始段和完整消息，可精确重放。

## 使用

```go
package main

import (
	"errors"
	"fmt"
	"os"

	dataeng "example.org/dataeng/q0233"
)

func main() {
	file, err := os.Open("messages.hl7")
	if err != nil {
		panic(err)
	}
	defer file.Close()

	batch, err := dataeng.ParseReader(file)
	if batch == nil {
		var parseErr *dataeng.ParseError
		if errors.As(err, &parseErr) {
			// 截断/封套错误：批次未发布，但证据仍可访问。
			fmt.Printf("rejected at line %d byte %d: %s\n",
				parseErr.Line, parseErr.Offset, parseErr.Detail)
			if parseErr.Batch != nil {
				for _, message := range parseErr.Batch.Messages {
					_ = message.Raw() // 完整原始消息，可重放
				}
			}
		}
		return
	}

	// 封套完整但有消息解码失败时，batch 仍返回用于隔离和重放。
	if err != nil {
		for _, message := range batch.Messages {
			if message.Err != nil {
				fmt.Printf("message %d failed at %s line %d; raw=%q\n",
					message.Index,
					message.Err.SegmentID,
					message.Err.Line,
					message.Err.RawMessage,
				)
			}
		}
	}

	fmt.Printf("declared=%d observed=%d valid=%d failed=%d published=%v\n",
		batch.BTSMessageCount,
		batch.ObservedMessages,
		batch.ValidMessages,
		batch.FailedMessages,
		batch.Published(),
	)
}
```

## 失败语义

- 结构性失败（`ErrTruncated`、`ErrCountMismatch`、缺少 `BTS`/`FTS` 等）：`Parse` 返回 `nil` 批次和 `ErrorList`。通过 `ParseError.Batch` 可读取未发布的证据。
- 消息失败（坏转义、错误分隔符等）：封套完整时返回批次和错误；`BTSMessageCount` 保持声明值，`Complete()` 仍为真，`Published()` 为假。
- `Batch.Complete()` 表示封套完整且计数一致；`Batch.Valid()` 表示消息也全部成功；`Batch.Published()` 表示两者都满足。
