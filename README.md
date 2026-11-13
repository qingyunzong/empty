# 网页正文版本差分

`dataeng` 是一个可直接导入 Go 服务的结构化正文差分库。输入两次抓取得到的正文块
（DOM 路径、文档文本区间、正文文本、发布时间证据），输出 `add`、`delete`、
`modify`、`split`、`merge` 和 `reorder` 事件。

## 语义

- 只有正文块参与比较。`KindAdvertisement`、`KindNavigation`、
  `KindBoilerplate` 块的整体增删或移动不会产生正文事件。
- DOM 数字下标在匹配前会被归一化为“同标签下的正文序号”，因此广告插入导致的
  `p[2] -> p[3]` 位移不会被误判为正文变化。
- 匹配顺序依次考虑稳定 `ID`、DOM 路径加文本、唯一文本、段落拆合、DOM 路径和
  文本相似度。
- 一段拆成多段产生一个 `split` 事件，多段合成一段产生一个 `merge` 事件；
  `Mapping` 给出新段落对应的旧块和旧块内 rune 区间，不会退化成 delete+add。
- 内容变化和顺序变化是独立事件。一个块既改文本又移动时，会同时得到一个
  `modify` 和一个 `reorder`，但两者不会混合在同一个事件里。
- 同一抓取世代内，`Ledger`/`Differ` 对逻辑相同的增删改事件只放行一次。重复抓取
  同一代页面不会重复投递事件。

## 快速开始

```go
package main

import (
	"fmt"

	"example.org/dataeng/q0077"
)

func main() {
	old := dataeng.Snapshot{
		Generation: "crawl-20261113-01",
		Blocks: []dataeng.Block{
			{ID: "p1", Path: "html>body>article>p[1]", Text: "第一段"},
			{ID: "p2", Path: "html>body>article>p[2]", Text: "第二段"},
		},
	}
	new := dataeng.Snapshot{
		Generation: "crawl-20261113-01",
		Blocks: []dataeng.Block{
			// 广告插入导致正文 DOM 下标变化，不产生事件。
			{ID: "ad1", Kind: dataeng.KindAdvertisement,
				Path: "html>body>article>div[1]", Text: "广告"},
			{ID: "p1", Path: "html>body>article>p[2]", Text: "第一段（修订）"},
			{ID: "p2a", Path: "html>body>article>p[3]", Text: "第二段"},
			{ID: "p2b", Path: "html>body>article>p[4]", Text: "续写"},
		},
	}

	differ := dataeng.NewDiffer()
	result := differ.Diff(old, new)
	for _, event := range result.Events {
		fmt.Printf("%s %s\n", event.Kind, event.BlockID)
	}

	// 同一个 Differ 再处理同一世代时会抑制已经输出过的事件。
	fmt.Println("second pass:", len(differ.Diff(old, new).Events))
}
```

如果只需要一次无状态比较，使用 `dataeng.Diff(old, new)`。需要跨多次抓取去重时，
使用 `dataeng.NewDiffer()`、`dataeng.NewLedger()` 或
`dataeng.NewGeneration(id)`。

## 数据模型

`Block` 的主要字段：

| 字段 | 说明 |
| --- | --- |
| `ID` | 可选稳定标识；跨快照稳定时优先用于匹配 |
| `Kind` | 正文/广告/导航/页面框架分类，零值视为正文 |
| `Path` | DOM 路径，支持 `a>b[2]>p[3]`、`/a/b[2]/p[3]` 等写法 |
| `Text` | 正文文本 |
| `Range` | 文档中的半开 rune 区间 `[Start, End)` |
| `PublishedAt` | 发布时间 |
| `PublishEvidence` | 发布时间证据列表，事件会原样携带 |

`SourceFragment` 的 `Start`/`End` 是旧块 `Text` 内的 rune 区间；
`Document` 是换算后的旧文档区间。

## 事件

| 事件 | 含义 |
| --- | --- |
| `add` | 新正文块 |
| `delete` | 删除正文块 |
| `modify` | 同一正文块文本变化 |
| `split` | 一段拆成多段，`Mapping` 给出各目标段的来源区间 |
| `merge` | 多段合成一段，`Mapping` 列出全部来源 |
| `reorder` | 仅顺序变化，`OrderChanges` 给出旧/新序号 |

`Result.ContentChanges()` 返回内容事件，`Result.OrderChanges()` 返回顺序事件。

## 验证

```bash
go test ./...
go vet ./...
```
