package dataeng

import (
	"math/rand"
	"testing"
)

// TestRandomizedAgainstOracle 随机生成合法 CIGAR 与窗口，
// 用逐碱基展开的 oracle 穷举核对裁剪与双向查询。
func TestRandomizedAgainstOracle(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	kinds := []Op{OpM, OpEqual, OpDiff, OpInsertion, OpDeletion, OpRefSkip, OpSoftClip}

	for iter := 0; iter < 400; iter++ {
		n := 1 + rng.Intn(8)
		var ops []Operation
		prev := OpHardClip + 1
		for len(ops) < n {
			kind := kinds[rng.Intn(len(kinds))]
			if kind == prev {
				continue
			}
			ops = append(ops, Operation{Kind: kind, Length: 1 + uint64(rng.Intn(4))})
			prev = kind
		}
		// 强制 S 只出现在两端：把内部 S 替换成 M。
		for i := 1; i < len(ops)-1; i++ {
			if ops[i].Kind == OpSoftClip {
				ops[i].Kind = OpM
			}
		}
		// 去重相邻同操作。
		cleaned := ops[:0]
		var last Op = OpHardClip + 1
		for _, op := range ops {
			if op.Kind == last {
				continue
			}
			cleaned = append(cleaned, op)
			last = op.Kind
		}
		ops = cleaned

		var readLen, refLen uint64
		for _, op := range ops {
			if op.Kind.ConsumesRead() {
				readLen += op.Length
			}
			if op.Kind.ConsumesRef() {
				refLen += op.Length
			}
		}
		s := uint64(rng.Intn(20))
		if refLen == 0 || readLen == 0 {
			continue
		}
		bases := make([]byte, readLen)
		quals := make([]byte, readLen)
		rec := &Record{RefStart: s, CIGAR: ops, Bases: bases, Qualities: quals}
		o := buildOracle(t, rec)

		limit := s + refLen + 4
		for w := 0; w < 12; w++ {
			L := uint64(rng.Intn(int(limit)))
			Rv := L + uint64(rng.Intn(int(limit-L)+1))
			expectClip(t, rec, o, L, Rv)
		}
	}
}
