# setlib

小整数域上的区间集合库（仅 Go 标准库）。

- 元素成员资格表示为多个有效半开区间 `[Lo, Hi)`（`Interval.Valid(): Lo < Hi`）。
- `Intersect` / `Intersector.Query` 计算多集合交集：相邻运行归并为单个输出区间，
  但每个输出区间附带来源证据（`Evidence []Contribution`），逐集合列出产生它的原始区间。
- 单成员更正走增量路径：`Upsert`/`Remove` 只按对称差调整逐点覆盖计数，
  不重算全部集合；集内存储保留证据形态（排序去重、不合并），计数使用其归并形式。
- 输出规范性：`Normalize` 丢弃无效区间、排序、合并重叠与相邻；`IsNormalized` 校验
  严格递增且互不相邻。

## 测试

`TestPerTickSimulation` 在域 `[0,48)` 内以固定种子驱动 3000 tick：
每 tick 随机做一次单成员更正（含无效区间输入）或成员移除，随后将增量结果与
逐点暴力重算逐一核对，并校验输出规范性与证据完备性（证据属于对应集合、
与结果相交、且每个集合的证据完整覆盖结果区间）。

## 实际测试结果（go1.27.1 linux/amd64）

```
$ go test ./... -count=1
ok  	setlib	0.022s

$ go test ./... -count=1 -race
ok  	setlib	1.315s
```

全部 5 个测试（含 7 个 Normalize 子用例）通过；`go vet ./...` 与 `gofmt -l .` 无输出。
