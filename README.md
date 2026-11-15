# API 软删除探测轮换

可导入的 Go 软删除探测组件，用于只提供“当前完整列表”、且调用配额有限的资源采集器。组件不直接发 HTTP 请求，调用方负责拉取列表；它负责维护资源状态、轮换复查旧 ID，并输出删除/恢复事件。

```go
import (
	"context"

	dataeng "example.org/dataeng/q0175"
)

detector, err := dataeng.New(dataeng.Config{
	DeleteAfter:      3, // 连续 3 次调度复查缺失才删除
	MaxRecheckCycles: 8, // 每个 ID 最多 8 个完整世代被复查一次
	HashSalt:         "resource-collector-v1",
})
if err != nil {
	panic(err)
}

// 每轮采集调用一次 Poll，一次调用最多推进一个完整世代。
events, err := detector.Poll(ctx, func(context.Context) (dataeng.Listing, error) {
	ids, err := fetchCurrentIDs(ctx)
	if err != nil {
		return dataeng.Listing{}, err
	}
	return dataeng.Listing{Complete: true, IDs: ids}, nil
})
```

也可以手工构造 `Listing` 后调用 `Observe`，便于接入已有的分页/重试流程。

## 完整世代

只有成功取到完整当前列表的响应才能设置 `Listing.Complete = true`。以下情况必须设为 `false`：

- HTTP 错误页、限流页、登录页或其他非资源列表页面；
- 分页未取全、结果被截断；
- JSON/HTML 解析失败；
- 临时网络错误。

不完整响应只增加 `IncompleteObservations`，不会推进世代，不会清空缺失计数，也不会产生删除事件。这样临时错误页不会误删资源。

## 轮换与复查上限

组件使用 rendezvous hashing（一致性哈希的一种）把每个 ID 映射到
`[0, MaxRecheckCycles)` 中的一个槽位。第 `g` 个完整世代复查槽位
`(g-1) % MaxRecheckCycles`。

- ID 的槽位只取决于 ID、槽位数量和 `HashSalt`，与当前存活集合无关；
  资源增删不会整体重排。
- 任意连续 `MaxRecheckCycles` 个完整世代都会覆盖所有槽位，因此每个 ID
  必在上限周期内被复查一次。
- `NextRecheck(id)` 可查询下一次复查的世代和等待世代数，返回值始终不超过
  `MaxRecheckCycles`。

删除阈值 `DeleteAfter` 按“已调度的完整世代复查”计。某个 ID 的缺失次数达到
阈值后，才输出一次 `EventDeleted`，之后即使继续缺失也不会重复删除。若一个
`DeleteAfter = K` 的资源最后一次出现后一直缺失，最迟在 `K * MaxRecheckCycles`
个完整世代内完成删除判定。

## 恢复版本

版本号按 ID 单调递增：

- 首次出现：版本 1，输出 `EventCreated`；
- 输出删除：版本加 1，输出 `EventDeleted`；
- 已删除资源重新出现：版本再加 1，输出 `EventRestored`。

下游可用恢复版本撤销本地软删除状态。

## 持久化

`Export` 返回可 JSON 序列化的状态，`NewFromState` 在下次启动时恢复。恢复时必须
使用相同的 `MaxRecheckCycles` 和 `HashSalt`，否则 ID 可能被分配到其他槽位。

```go
import "encoding/json"

state := detector.Export()
blob, _ := json.Marshal(state)

// 重启后
detector, err = dataeng.NewFromState(cfg, state)
```

## 验证

```sh
go test ./...
go vet ./...
```
