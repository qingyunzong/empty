# 可合并的确定性样本去重

采集画像服务调用可导入的Go优先样本包，记录带唯一ID、正整数权重及uint64优先数；优先级按优先数除以权重的精确有理数升序，平局按ID字节序。维护最小K条，K非负；同ID同内容重投忽略，异内容报冲突。分片摘要须支持合并成与全量采样相同的结果，但不能因某ID未入样本就漏检其冲突，允许摘要另保存ID完整内容索引或保证无碰撞的调用方指纹索引。用随机分片、合并顺序及超大权重验证样本与冲突行为。

## 设计要点

- `Item{ID, Weight, Priority}`：权重必须为正整数，优先数为 `uint64`。
- 排序键为精确有理数 `Priority/Weight` 升序；交叉乘积用 `math/bits.Mul64`
  做 128 位比较，避免 `uint64` 乘法溢出与浮点误差；平局按 ID 字节序。
- `Sampler` 用容量 K 的最大堆维护排名最小的 K 条，K=0 时只建索引不入样。
- 同 ID 同内容的重投幂等忽略；同 ID 异内容返回 `*ConflictError`，且不改变状态。
- `Summary` 保存全部已观测 ID 的完整内容索引（而非仅样本），因此未入样的
  ID 发生异内容时，`Merge` 仍能检出 `*MergeError`。
- 合并结果与分片方式、合并顺序无关；相同内容跨片去重，异内容按 ID 汇总冲突。

## 用法

```go
package main

import (
	"fmt"

	dataeng "example.org/dataeng/q0109"
)

func main() {
	s := dataeng.NewSampler(10)
	err := s.Add(dataeng.Item{ID: "call-1", Weight: 4, Priority: 1})
	if err != nil {
		// dataeng.ErrZeroWeight 或 *dataeng.ConflictError
		panic(err)
	}

	snapshot := s.Snapshot() // 可序列化/跨机传输的分片摘要

	merged, err := dataeng.Merge(snapshot, otherShardSnapshot)
	if err != nil {
		var conflict *dataeng.MergeError
		// errors.As(err, &conflict) 后读取 conflict.IDs()
		panic(err)
	}
	fmt.Println(merged.Sample()) // 与单机全量采样完全一致
}
```

## 验证

- `go test ./...`：包含确定性用例与 300 轮随机属性测试。
- 随机分片：每轮随机条数、K（含 0 与 K>n）、分片数与投放顺序。
- 合并顺序：直接合并与随机置换后的两两平衡合并，结果必须一致。
- 超大权重：覆盖 `math.MaxUint64`、2 的幂及高位权重，交叉乘积可达 127 位。
- 冲突：随机挑选可能从未入样的 ID 注入异内容，多轮不同合并顺序均稳定报冲突。
- `go test -race` 通过，语句覆盖率 95% 以上。
