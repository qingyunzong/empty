# 电话 E.164 区域解释（`dataeng`）

这是一个可直接导入的 Go 电话号码解释组件。调用方提供一份版本化的国家/地区号码计划元数据和默认地区；组件返回所有由该元数据支持的结构化解释，而不是只返回一个“格式化后的号码”。

```go
package main

import (
	"fmt"
	"log"

	"example.org/dataeng/q0119"
)

func main() {
	meta := dataeng.Metadata{
		Version: "2026-11",
		Regions: map[string]dataeng.Region{
			"GB": {
				CountryCode:           "44",
				InternationalPrefix:   "00",
				NationalPrefix:        "0",
				NationalNumberLengths: []int{10},
			},
			"US": {
				CountryCode:           "1",
				InternationalPrefix:   "011",
				NationalPrefix:        "1",
				NationalNumberLengths: []int{10},
			},
		},
	}

	interpreter, err := dataeng.NewInterpreter(meta, "GB")
	if err != nil {
		log.Fatal(err)
	}

	result, err := interpreter.Interpret("+44 (0)20 7946 0018 ext. 42")
	if err != nil {
		log.Fatal(err)
	}
	for _, candidate := range result.Interpretations {
		fmt.Printf("%s: country=%s trunk=%q nsn=%s ext=%q possible=%s valid=%s e164=%s\n",
			candidate.Kind,
			candidate.CountryCode,
			candidate.TrunkPrefix,
			candidate.NationalNumber,
			candidate.Extension,
			candidate.Possibility,
			candidate.Validity,
			candidate.E164,
		)
	}
}
```

## 元数据

`Metadata` 表示一个元数据世代；世代标签使用 `Version`（也接受 `Generation` 别名）。`Regions`（也接受 `Countries` 作为别名）以地区标识为键。`Region` 支持：

- `CountryCode` / `CallingCode`：E.164 国家码。
- `InternationalPrefix` / `InternationalPrefixes`：国际直拨前缀，例如 `00`、`011`。
- `NationalPrefix` / `TrunkPrefix` / `Trunk` / `NationalPrefixes` / `TrunkPrefixes`：国内 trunk 前缀。
- `NationalNumberLengths` / `PossibleLengths` / `NumberLengths`：允许的 national significant number 长度。
- `ValidNumberPatterns` / `ValidNationalNumberPatterns`：可选的显式有效性规则；规则只针对 NSN，不会根据“能格式化”推断有效。

国际前缀未填写时，组件对 `CountryCode == "1"` 使用 `011`，其他地区使用 `00`，并在候选证据中标记这个假设。trunk 前缀不会猜测。

`LoadMetadata(io.Reader)` 可直接读取 JSON。JSON 中的单数/复数字段同样会合并。

## 解释结果

`Interpreter.Interpret(input)` 返回 `Result`：

- `Result.Interpretations`：所有结构上不同的解释；`possible` 候选在前，其次按国际显式 `+`、IDD、国内 trunk、无 trunk、裸国家码等优先级排序。
- `Result.Issues`：无法使用的字符、未知国家码、缺少默认地区等非致命问题。
- `Result.MetadataVersion` / `Result.MetadataDigest`：产生该结果时冻结的元数据世代。

每个 `Interpretation` 明确区分：

- `InternationalPrefix`、`CountryCode`、`TrunkPrefix`、`NationalNumber`、`Extension`；
- `Kind`（`international_plus`、`international_idd`、`international_bare`、`national_trunk`、`national`）；
- `Possibility`（`unknown` / `possible` / `impossible`）与 `Validity`（`unknown` / `valid` / `invalid`）；
- `WellFormed`、`Possible`、`Valid` 便捷布尔值；
- `E164`、`RFC3966` 以及逐项 `Evidence`。

`Possible` 只表示 NSN 长度在元数据中声明；`Valid` 只可能来自显式的 `ValidNumberPatterns`。解析成功、格式化成功或 E.164 拼接成功都不会把 `Validity` 设为 `valid`。

结构上成立的候选（例如 `020...` 既可以解释为带 trunk，也可以解释为不带 trunk）都会保留；即使某个候选的长度被元数据判定为 `impossible`，它仍带有完整证据，便于调用方区分“无法解释”和“可以格式化但按元数据不可能”。

## 证据

`Evidence` 带有原始输入中的半开字节区间 `Span`，并把 `Text`（原始片段）与 `Value`（规范化值）分开。例如：

- 国际前缀：`+` 或 `00`/`011`；
- 国家码及匹配到的地区；
- 被剥离的国内 trunk，以及它是否位于括号中；
- NSN 的原始片段；
- extension 标记与 extension 数字；
- 长度可能性判定、显式有效性判定、地区歧义和元数据假设。

同一国家码被多个地区共享时（例如 `1` 被 `US`/`CA` 共享），候选会合并为一条记录并通过 `RegionCandidates`、`RegionAmbiguous` 和 `ambiguity` 证据说明歧义；`Region` 优先取调用方默认地区。

## 元数据世代不可变性

`NewInterpreter` 会深拷贝并规范化元数据，计算 SHA-256 摘要，然后只使用这个只读快照。之后修改调用方原来的 map、slice 或创建新的元数据世代，都不会改变已经生成的结果。旧记录始终携带旧世代的 `MetadataVersion` 和 `MetadataDigest`；不同世代即使号码计划内容相同，只要 `Version` 不同，摘要也不同。

组件本身无外部依赖，可安全并发使用。

## 测试

```sh
go test ./...
go vet ./...
```
