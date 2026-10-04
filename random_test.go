package kvmerge

import (
	"fmt"
	"math/rand"
	"testing"
)

// checkAgainstStore 将“合并输出 + 未参与合并的剩余段”构成的读模型
// 与未压缩基准在所有键、所有读者序号上逐一比对。
func checkAgainstStore(t *testing.T, w Workload, merged []Entry, rest []Segment, readers []uint64) {
	t.Helper()
	ref := NewStore()
	for _, s := range w.Segments {
		ref.AddSegment(s)
	}
	compressed := NewStore()
	compressed.AddSegment(Segment{Entries: merged})
	for _, s := range rest {
		compressed.AddSegment(s)
	}
	for _, k := range w.Keys {
		for _, r := range readers {
			gv, gok := compressed.Get(k, r)
			wv, wok := ref.Get(k, r)
			if gv != wv || gok != wok {
				t.Fatalf("键 %s 在序号 %d 处不一致：压缩模型=(%q,%v) 未压缩模型=(%q,%v)",
					k, r, gv, gok, wv, wok)
			}
		}
	}
}

func readersOf(w Workload) []uint64 {
	readers := append([]uint64{}, w.Snapshots...)
	return append(readers, LatestSeq)
}

func TestRandomizedFullCompaction(t *testing.T) {
	for seed := int64(1); seed <= 40; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			w := GenWorkload(rand.New(rand.NewSource(seed)))
			res := Merge(w.Segments, w.Snapshots, true)
			checkAgainstStore(t, w, res.Output, nil, readersOf(w))
			total := 0
			for _, s := range w.Segments {
				total += len(s.Entries)
			}
			if len(res.Decisions) != total {
				t.Fatalf("决策数 %d 应等于输入条目数 %d", len(res.Decisions), total)
			}
			for _, d := range res.Decisions {
				if d.Reason == "" {
					t.Fatalf("条目 %v 缺少去留原因", d.Entry)
				}
			}
			t.Logf("输入 %d 条，保留 %d 条，快照 %v", total, len(res.Output), w.Snapshots)
		})
	}
}

func TestRandomizedPartialCompaction(t *testing.T) {
	for seed := int64(100); seed < 140; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			w := GenWorkload(rand.New(rand.NewSource(seed)))
			cut := 1 + rand.New(rand.NewSource(seed*7)).Intn(len(w.Segments)-1)
			top, rest := w.Segments[:cut], w.Segments[cut:]
			res := Merge(top, w.Snapshots, false)
			checkAgainstStore(t, w, res.Output, rest, readersOf(w))
		})
	}
}

func TestRegistry(t *testing.T) {
	reg := NewRegistry()
	reg.Register(3)
	reg.Register(3)
	reg.Register(7)
	if got := reg.Snapshots(); fmt.Sprint(got) != "[3 7]" {
		t.Fatalf("快照列表应为 [3 7]，得到 %v", got)
	}
	reg.Unregister(3)
	if got := reg.Snapshots(); fmt.Sprint(got) != "[3 7]" {
		t.Fatalf("注销一个重复注册后应仍为 [3 7]，得到 %v", got)
	}
	reg.Unregister(3)
	reg.Unregister(7)
	if got := reg.Snapshots(); len(got) != 0 {
		t.Fatalf("全部注销后应为空，得到 %v", got)
	}
}
