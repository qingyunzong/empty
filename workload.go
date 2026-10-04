package kvmerge

import (
	"fmt"
	"math/rand"
	"sort"
)

// Workload 是一份随机分层数据：若干层段与一组已注册快照序号。
type Workload struct {
	Keys      []string
	Segments  []Segment
	Snapshots []uint64
	MaxSeq    uint64
}

// GenWorkload 用 rnd 生成随机分层数据：在随机键集合上执行一系列
// 随机写/删操作（序号递增），切成 2~5 层段，并注册 0~4 个快照读者。
func GenWorkload(rnd *rand.Rand) Workload {
	nKeys := 3 + rnd.Intn(6)
	keys := make([]string, nKeys)
	for i := range keys {
		keys[i] = fmt.Sprintf("key-%d", i)
	}
	nOps := 50 + rnd.Intn(150)
	ops := make([]Entry, 0, nOps)
	for seq := 1; seq <= nOps; seq++ {
		k := keys[rnd.Intn(nKeys)]
		if rnd.Intn(5) == 0 {
			ops = append(ops, Entry{Key: k, Seq: uint64(seq), Del: true})
		} else {
			ops = append(ops, Entry{Key: k, Seq: uint64(seq), Val: fmt.Sprintf("val-%d", rnd.Intn(10000))})
		}
	}
	nSegs := 2 + rnd.Intn(4)
	cuts := make([]int, 0, nSegs)
	for len(cuts) < nSegs-1 {
		c := rnd.Intn(nOps + 1)
		dup := c == nOps
		for _, x := range cuts {
			if x == c {
				dup = true
				break
			}
		}
		if !dup {
			cuts = append(cuts, c)
		}
	}
	sort.Ints(cuts)
	cuts = append(cuts, nOps)
	segs := make([]Segment, 0, nSegs)
	prev := 0
	for level, c := range cuts {
		segs = append(segs, NewSegment(level, ops[prev:c]))
		prev = c
	}
	nSnaps := rnd.Intn(5)
	snaps := make([]uint64, 0, nSnaps)
	for i := 0; i < nSnaps; i++ {
		snaps = append(snaps, uint64(rnd.Intn(nOps+1)))
	}
	return Workload{Keys: keys, Segments: segs, Snapshots: snaps, MaxSeq: uint64(nOps)}
}
