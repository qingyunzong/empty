package formal

import (
	"sort"
	"time"
)

// TaskID 标识一个需要提交 shuffle 分区的任务。
type TaskID string

// AttemptID 标识某个任务的一次执行尝试。
type AttemptID string

// ExecutorID 标识一个可执行尝试的工作节点。
type ExecutorID string

// ShufflePartition 标识任务产出的 shuffle 分区。同一分区全局只能提交一次。
type ShufflePartition string

// ResourceSpec 描述一次尝试预留的资源量。
type ResourceSpec struct {
	CPUMillis int64
	MemoryMB  int64
}

// Add 返回两个资源量之和。
func (r ResourceSpec) Add(o ResourceSpec) ResourceSpec {
	return ResourceSpec{CPUMillis: r.CPUMillis + o.CPUMillis, MemoryMB: r.MemoryMB + o.MemoryMB}
}

// Sub 返回两个资源量之差。
func (r ResourceSpec) Sub(o ResourceSpec) ResourceSpec {
	return ResourceSpec{CPUMillis: r.CPUMillis - o.CPUMillis, MemoryMB: r.MemoryMB - o.MemoryMB}
}

// IsZero 报告资源量是否为零。
func (r ResourceSpec) IsZero() bool {
	return r.CPUMillis == 0 && r.MemoryMB == 0
}

// ResourceUsage 是按运行时长折算的资源用量（资源量 × 纳秒）。
type ResourceUsage struct {
	CPUMillisNanos int64
	MemoryMBNanos  int64
}

// holdAccount 按资源生命周期记账：
//   - HoldPlaced：尝试启动时预留资源，hold 增加；
//   - UsageBilled：尝试运行期间按墙钟时间折算用量，billed 增加；
//   - HoldReleased：尝试终结时释放预留，hold 减少。
//
// 守恒不变量：任意时刻 hold 不得为负，且每个已终结尝试满足
// 累计 hold == 累计 release；全部尝试终结后总 hold 归零。
type holdAccount struct {
	hold     ResourceSpec
	billed   ResourceUsage
	placed   ResourceSpec
	released ResourceSpec
}

func (a *holdAccount) place(spec ResourceSpec) {
	a.hold = a.hold.Add(spec)
	a.placed = a.placed.Add(spec)
}

func (a *holdAccount) bill(spec ResourceSpec, d time.Duration) {
	nanos := d.Nanoseconds()
	a.billed.CPUMillisNanos += spec.CPUMillis * nanos
	a.billed.MemoryMBNanos += spec.MemoryMB * nanos
}

func (a *holdAccount) release(spec ResourceSpec) {
	a.hold = a.hold.Sub(spec)
	a.released = a.released.Add(spec)
}

// Quantile 按最近秩（nearest-rank）方法返回样本的 q 分位数，
// q 取值范围为 (0,1]。空样本返回 0。
//
// 最近秩定义：rank = ceil(q * n)，取升序排列后的第 rank 个元素。
func Quantile(samples []time.Duration, q float64) time.Duration {
	if len(samples) == 0 || q <= 0 {
		return 0
	}
	if q > 1 {
		q = 1
	}
	sorted := append([]time.Duration(nil), samples...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	rank := int(q*float64(len(sorted)) + 0.999999999)
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

// insertSorted 向已升序排列的切片插入一个值并保持有序。
func insertSorted(samples []time.Duration, v time.Duration) []time.Duration {
	i := sort.Search(len(samples), func(i int) bool { return samples[i] >= v })
	samples = append(samples, 0)
	copy(samples[i+1:], samples[i:])
	samples[i] = v
	return samples
}

// slowThreshold 返回应启动推测副本的运行时长阈值。
// 历史样本不足 MinHistorySamples 时返回 0，表示暂不推测。
func slowThreshold(history []time.Duration, cfg Config) time.Duration {
	if len(history) < cfg.MinHistorySamples {
		return 0
	}
	return Quantile(history, cfg.SlowQuantile)
}

// timeoutThreshold 返回尝试的硬超时时长。TimeoutMultiplier <= 0
// 时返回 0，表示禁用硬超时，慢任务只能通过推测或执行器丢失终结。
func timeoutThreshold(history []time.Duration, cfg Config) time.Duration {
	if cfg.TimeoutMultiplier <= 0 {
		return 0
	}
	if len(history) < cfg.MinHistorySamples {
		return 0
	}
	return time.Duration(float64(Quantile(history, cfg.TimeoutQuantile)) * cfg.TimeoutMultiplier)
}
