package counterlib

import (
	"math/rand"
	"reflect"
	"testing"
)

// ---- 手写边界用例 ----

func TestHandwrittenBoundaries(t *testing.T) {
	tests := []struct {
		name    string
		counter Counter
		samples []Sample
		want    []Interval
	}{
		{
			name:    "普通递增",
			counter: Counter{Bits: 8},
			samples: []Sample{{Time: 1, Value: 10}, {Time: 2, Value: 25}},
			want:    []Interval{{From: 1, To: 2, Delta: 15, Known: true}},
		},
		{
			name:    "恰好回到零补模一次",
			counter: Counter{Bits: 8, AllowWrap: true},
			samples: []Sample{{Time: 1, Value: 255}, {Time: 2, Value: 0}},
			want:    []Interval{{From: 1, To: 2, Delta: 1, Known: true}},
		},
		{
			name:    "下降补模一次",
			counter: Counter{Bits: 8, AllowWrap: true},
			samples: []Sample{{Time: 1, Value: 250}, {Time: 2, Value: 5}},
			want:    []Interval{{From: 1, To: 2, Delta: 11, Known: true}},
		},
		{
			name:    "不允许回卷时下降为未知",
			counter: Counter{Bits: 8},
			samples: []Sample{{Time: 1, Value: 250}, {Time: 2, Value: 5}},
			want:    []Interval{{From: 1, To: 2, Known: false}},
		},
		{
			name:    "不推测多次回卷",
			counter: Counter{Bits: 8, AllowWrap: true},
			// 真实增量 300（超过模 256），库只按一次回卷补模得 44。
			samples: []Sample{{Time: 1, Value: 200}, {Time: 2, Value: 244}},
			want:    []Interval{{From: 1, To: 2, Delta: 44, Known: true}},
		},
		{
			name:    "显式重置使区间未知且重置值成为新基线",
			counter: Counter{Bits: 8, AllowWrap: true},
			samples: []Sample{
				{Time: 1, Value: 200},
				{Time: 2, Value: 3, Reset: true},
				{Time: 3, Value: 10},
			},
			want: []Interval{
				{From: 1, To: 2, Known: false},
				{From: 2, To: 3, Delta: 7, Known: true},
			},
		},
		{
			name:    "重复时刻取版本高者",
			counter: Counter{Bits: 8},
			samples: []Sample{
				{Time: 1, Value: 10},
				{Time: 2, Value: 99, Version: 1},
				{Time: 2, Value: 30, Version: 3},
				{Time: 2, Value: 77, Version: 2},
			},
			want: []Interval{{From: 1, To: 2, Delta: 20, Known: true}},
		},
		{
			name:    "重复时刻版本相同取先出现者",
			counter: Counter{Bits: 8},
			samples: []Sample{
				{Time: 1, Value: 10},
				{Time: 2, Value: 30, Version: 5},
				{Time: 2, Value: 99, Version: 5},
			},
			want: []Interval{{From: 1, To: 2, Delta: 20, Known: true}},
		},
		{
			name:    "乱序输入",
			counter: Counter{Bits: 8},
			samples: []Sample{{Time: 3, Value: 40}, {Time: 1, Value: 10}, {Time: 2, Value: 20}},
			want: []Interval{
				{From: 1, To: 2, Delta: 10, Known: true},
				{From: 2, To: 3, Delta: 20, Known: true},
			},
		},
		{
			name:    "1 位计数器逐位翻转",
			counter: Counter{Bits: 1, AllowWrap: true},
			samples: []Sample{{Time: 1, Value: 0}, {Time: 2, Value: 1}, {Time: 3, Value: 0}, {Time: 4, Value: 1}},
			want: []Interval{
				{From: 1, To: 2, Delta: 1, Known: true},
				{From: 2, To: 3, Delta: 1, Known: true},
				{From: 3, To: 4, Delta: 1, Known: true},
			},
		},
		{
			name:    "64 位计数器绕回",
			counter: Counter{Bits: 64, AllowWrap: true},
			samples: []Sample{{Time: 1, Value: ^uint64(0)}, {Time: 2, Value: 3}},
			want:    []Interval{{From: 1, To: 2, Delta: 4, Known: true}},
		},
		{
			name:    "读数高位越界按位宽截断",
			counter: Counter{Bits: 8},
			samples: []Sample{{Time: 1, Value: 0x1FE}, {Time: 2, Value: 0x2FF}},
			want:    []Interval{{From: 1, To: 2, Delta: 1, Known: true}},
		},
		{
			name:    "空输入",
			counter: Counter{Bits: 8},
			samples: nil,
			want:    nil,
		},
		{
			name:    "单一有效采样",
			counter: Counter{Bits: 8},
			samples: []Sample{{Time: 1, Value: 5, Version: 1}, {Time: 1, Value: 9, Version: 2}},
			want:    nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := tt.counter.Process(tt.samples)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("Process() = %+v, want %+v", got, tt.want)
			}
		})
	}
}

// ---- 重建模型对照 ----

// modelSample 是重建模型内部使用的有效采样记录。
type modelSample struct {
	value uint64
	reset bool
}

// rebuild 是独立的重建模型：用排序法（而非库的 map 法）确定每个时刻的
// 有效采样，再按规则直接推出期望区间，与库的实现交叉对照。
func rebuild(c Counter, samples []Sample) []Interval {
	byTime := make(map[int64][]Sample)
	for _, s := range samples {
		byTime[s.Time] = append(byTime[s.Time], s)
	}
	times := make([]int64, 0, len(byTime))
	for tm := range byTime {
		times = append(times, tm)
	}
	sortInts(times)

	mask := c.mask()
	eff := make([]modelSample, 0, len(times))
	for _, tm := range times {
		group := byTime[tm]
		best := group[0]
		for _, s := range group[1:] {
			if s.Version > best.Version {
				best = s
			}
		}
		eff = append(eff, modelSample{value: best.Value & mask, reset: best.Reset})
	}

	var out []Interval
	for i := 1; i < len(times); i++ {
		iv := Interval{From: times[i-1], To: times[i]}
		prev, cur := eff[i-1], eff[i]
		switch {
		case cur.reset:
		case cur.value >= prev.value:
			iv.Delta = (cur.value - prev.value) & mask
			iv.Known = true
		case c.AllowWrap:
			iv.Delta = (cur.value - prev.value) & mask
			iv.Known = true
		}
		out = append(out, iv)
	}
	return out
}

func sortInts(xs []int64) {
	for i := 1; i < len(xs); i++ {
		for j := i; j > 0 && xs[j] < xs[j-1]; j-- {
			xs[j], xs[j-1] = xs[j-1], xs[j]
		}
	}
}

// TestReconstructionModel 随机生成带真值的采样流，库输出须与重建模型一致，
// 且已知区间的增量须等于真实增量（至多一次回卷）。
func TestReconstructionModel(t *testing.T) {
	bitWidths := []uint{1, 2, 4, 8, 16, 32, 63, 64}
	for _, seed := range []int64{1, 7, 42, 2026} {
		rng := rand.New(rand.NewSource(seed))
		for _, bits := range bitWidths {
			ctr := Counter{Bits: bits, AllowWrap: rng.Intn(2) == 0}
			mask := ctr.mask()

			var samples []Sample
			var trueInc []uint64 // 每个区间的真实增量（重置区间无效）
			var resetAt []bool   // 每个区间终点是否带重置标记
			tm := int64(0)
			value := uint64(rng.Intn(4)) & mask
			samples = append(samples, Sample{Time: tm, Value: value})
			steps := 50
			for i := 0; i < steps; i++ {
				tm += int64(1 + rng.Intn(5))
				if rng.Intn(10) == 0 {
					value = uint64(rng.Intn(8)) & mask
					samples = append(samples, Sample{Time: tm, Value: value, Reset: true})
					trueInc = append(trueInc, 0)
					resetAt = append(resetAt, true)
					continue
				}
				// 增量恒小于模，保证相邻采样间至多一次回卷。
				inc := rng.Uint64() & mask
				value = (value + inc) & mask
				samples = append(samples, Sample{Time: tm, Value: value})
				trueInc = append(trueInc, inc)
				resetAt = append(resetAt, false)
			}
			// 注入重复时刻：低版本错误值（应被忽略）与高版本正确值（应被选中）。
			n := len(samples)
			for i := 1; i < n; i++ {
				switch rng.Intn(4) {
				case 0:
					samples = append(samples, Sample{Time: samples[i].Time, Value: uint64(rng.Intn(256)), Version: 1})
					samples[i].Version = 2 // 原正确值升为高版本
				case 1:
					samples[i].Version = 3
					samples = append(samples, Sample{Time: samples[i].Time, Value: samples[i].Value, Version: 2})
				}
			}
			// 打乱输入顺序。
			rng.Shuffle(len(samples), func(i, j int) { samples[i], samples[j] = samples[j], samples[i] })

			got := ctr.Process(samples)
			want := rebuild(ctr, samples)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("seed=%d bits=%d: 库输出与重建模型不一致\ngot  %+v\nwant %+v", seed, bits, got, want)
			}
			// 与真值对照：非重置区间若已知，增量须等于真实增量；
			// 不允许回卷且发生回卷的区间必须为未知。
			if len(got) != steps {
				t.Fatalf("seed=%d bits=%d: 区间数 %d, want %d", seed, bits, len(got), steps)
			}
			for i, iv := range got {
				if resetAt[i] {
					if iv.Known {
						t.Fatalf("seed=%d bits=%d 区间%d: 重置区间被标记为已知", seed, bits, i)
					}
					continue
				}
				wrapped := trueInc[i] > 0 && (samplesValue(samples, iv.From)+trueInc[i])&mask < samplesValue(samples, iv.From)
				if iv.Known {
					if iv.Delta != trueInc[i] {
						t.Fatalf("seed=%d bits=%d 区间%d: Delta=%d, 真实增量=%d", seed, bits, i, iv.Delta, trueInc[i])
					}
				} else if !wrapped || ctr.AllowWrap {
					t.Fatalf("seed=%d bits=%d 区间%d: 应可计算却未知", seed, bits, i)
				}
			}
		}
	}
}

// samplesValue 返回某时刻最高版本采样的值（测试辅助）。
func samplesValue(samples []Sample, tm int64) uint64 {
	var best Sample
	found := false
	for _, s := range samples {
		if s.Time == tm && (!found || s.Version > best.Version) {
			best, found = s, true
		}
	}
	return best.Value
}
