package dataeng

import (
	"errors"
	"math"
	"testing"
)

// oracle 是用逐碱基展开方式独立构建的参照模型，
// 与 Clip 的区间运算实现完全独立。
type oracle struct {
	refStart uint64
	// refBase[r] 是参考坐标 r 对应的原始读段下标；缺口坐标不存在该键。
	refBase map[uint64]uint64
	// insAt[p] 是锚定在参考坐标 p 的插入读段下标列表。
	insAt map[uint64][]uint64
	readN uint64
}

// buildOracle 逐碱基展开原始 CIGAR。
func buildOracle(t *testing.T, r *Record) oracle {
	t.Helper()
	o := oracle{refStart: r.RefStart, refBase: map[uint64]uint64{}, insAt: map[uint64][]uint64{}}
	refPos := r.RefStart
	var readPos uint64
	for _, op := range r.CIGAR {
		for k := uint64(0); k < op.Length; k++ {
			switch op.Kind {
			case OpM, OpEqual, OpDiff:
				o.refBase[refPos] = readPos
				refPos++
				readPos++
			case OpInsertion:
				o.insAt[refPos] = append(o.insAt[refPos], readPos)
				readPos++
			case OpDeletion, OpRefSkip:
				refPos++
			case OpSoftClip:
				readPos++
			case OpHardClip:
				// 不推进任何游标。
			}
		}
	}
	o.readN = readPos
	return o
}

// makeRecord 用 CIGAR 字符串构造记录，碱基/质量按读长自动生成。
func makeRecord(t *testing.T, s uint64, cigar string) *Record {
	t.Helper()
	ops, err := ParseCIGAR(cigar)
	if err != nil {
		t.Fatalf("ParseCIGAR(%q): %v", cigar, err)
	}
	var readLen uint64
	for _, op := range ops {
		if op.Kind.ConsumesRead() {
			readLen += op.Length
		}
	}
	bases := make([]byte, readLen)
	quals := make([]byte, readLen)
	for i := range bases {
		bases[i] = byte('A' + (i % 26))
		quals[i] = byte(30 + (i % 10))
	}
	return &Record{RefStart: s, CIGAR: ops, Bases: bases, Qualities: quals}
}

// gapKindAt 返回参考坐标 ref 处的缺口操作类型（D/N），非缺口返回 0。
func gapKindAt(r *Record, ref uint64) Op {
	refPos := r.RefStart
	for _, op := range r.CIGAR {
		if !op.Kind.ConsumesRef() {
			continue
		}
		if refPos <= ref && ref < refPos+op.Length {
			if op.Kind == OpDeletion || op.Kind == OpRefSkip {
				return op.Kind
			}
			return 0
		}
		refPos += op.Length
	}
	return 0
}

// insertionAnchor 判断原始读段下标是否属于某个 I，返回其锚点。
func insertionAnchor(o oracle, origIdx uint64) (uint64, bool) {
	for p, idxs := range o.insAt {
		for _, idx := range idxs {
			if idx == origIdx {
				return p, true
			}
		}
	}
	return 0, false
}

// expectClip 用 oracle 逐坐标核对一次裁剪结果。
func expectClip(t *testing.T, r *Record, o oracle, L, Rv uint64) *Clipped {
	t.Helper()
	c, err := Clip(r, L, Rv)
	if err != nil {
		t.Fatalf("Clip([%d,%d)): %v", L, Rv, err)
	}

	wantMatch := false
	for ref := range o.refBase {
		if L <= ref && ref < Rv {
			wantMatch = true
			break
		}
	}
	if !wantMatch {
		if !c.Empty {
			t.Fatalf("Clip([%d,%d)): 期望 empty，得到 %s", L, Rv, c.CIGARString())
		}
		return c
	}
	if c.Empty {
		t.Fatalf("Clip([%d,%d)): 意外 empty", L, Rv)
	}

	// 新起点 = 记录与窗口交集内首个消费参考的坐标（含 D/N）。
	wantStart := uint64(math.MaxUint64)
	for ref := range o.refBase {
		if L <= ref && ref < Rv && ref >= r.RefStart && ref < wantStart {
			wantStart = ref
		}
	}
	refPos := r.RefStart
	for _, op := range r.CIGAR {
		if !op.Kind.ConsumesRef() {
			continue
		}
		for k := uint64(0); k < op.Length; k++ {
			if L <= refPos && refPos < Rv && refPos < wantStart {
				wantStart = refPos
			}
			refPos++
		}
	}
	if c.RefStart != wantStart {
		t.Fatalf("Clip([%d,%d)): RefStart=%d 期望 %d", L, Rv, c.RefStart, wantStart)
	}

	// 规范化 CIGAR：无 H/S，无相邻同操作，长度均为正。
	for i, op := range c.CIGAR {
		if op.Kind == OpHardClip || op.Kind == OpSoftClip {
			t.Fatalf("Clip([%d,%d)): 输出残留 %s", L, Rv, op.Kind)
		}
		if op.Length == 0 {
			t.Fatalf("Clip([%d,%d)): 出现零长度操作", L, Rv)
		}
		if i > 0 && c.CIGAR[i-1].Kind == op.Kind {
			t.Fatalf("Clip([%d,%d)): 相邻同操作未合并", L, Rv)
		}
	}

	// 期望保留的原始读段下标集合（M/=/X 交集 + 锚点在窗口内的 I）。
	wantRead := map[uint64]bool{}
	for ref, base := range o.refBase {
		if L <= ref && ref < Rv {
			wantRead[base] = true
		}
	}
	for p, idxs := range o.insAt {
		if L <= p && p < Rv {
			for _, idx := range idxs {
				wantRead[idx] = true
			}
		}
	}
	if len(wantRead) == 0 {
		if c.ReadRetained {
			t.Fatalf("Clip([%d,%d)): 不应保留读段", L, Rv)
		}
	} else {
		var lo, hi uint64 = math.MaxUint64, 0
		for idx := range wantRead {
			if idx < lo {
				lo = idx
			}
			if idx+1 > hi {
				hi = idx + 1
			}
		}
		for x := lo; x < hi; x++ {
			if !wantRead[x] {
				t.Fatalf("Clip([%d,%d)): 保留读段不连续，缺 %d", L, Rv, x)
			}
		}
		if !c.ReadRetained || c.ReadStart != lo || c.ReadEnd != hi {
			t.Fatalf("Clip([%d,%d)): 读段区间=[%d,%d) 期望 [%d,%d)",
				L, Rv, c.ReadStart, c.ReadEnd, lo, hi)
		}
		if string(c.Bases) != string(r.Bases[lo:hi]) ||
			string(c.Qualities) != string(r.Qualities[lo:hi]) {
			t.Fatalf("Clip([%d,%d)): 碱基/质量切片与原序列不一致", L, Rv)
		}
	}

	assertQueries(t, r, o, c, L, Rv)
	return c
}

// assertQueries 对窗口内每个参考坐标与每个本地读段下标做双向核对。
func assertQueries(t *testing.T, r *Record, o oracle, c *Clipped, L, Rv uint64) {
	t.Helper()
	refEnd := c.RefStart + c.RefLength()

	// 只遍历记录实际覆盖的参考坐标；窗口可能比记录更宽。
	spanStart := maxU64(L, c.RefStart)
	spanEnd := minU64(Rv, c.RefStart+c.RefLength())
	for ref := spanStart; ref < spanEnd; ref++ {
		pos, err := c.MapRef(ref)
		if err != nil {
			t.Fatalf("MapRef(%d): %v", ref, err)
		}
		if baseIdx, isBase := o.refBase[ref]; isBase {
			if pos.Kind != KindAligned {
				t.Fatalf("MapRef(%d): 期望 aligned，kind=%d", ref, pos.Kind)
			}
			local := baseIdx - c.ReadStart
			if pos.ReadIndex != local {
				t.Fatalf("MapRef(%d): ReadIndex=%d 期望 %d", ref, pos.ReadIndex, local)
			}
			back, err := c.MapRead(local)
			if err != nil || back.Kind != KindAligned || back.RefCoord != ref {
				t.Fatalf("MapRead(%d) 回查失败: %+v err=%v", local, back, err)
			}
			continue
		}
		wantKind := gapKindAt(r, ref)
		if wantKind == 0 {
			continue
		}
		if (wantKind == OpDeletion && pos.Kind != KindDeletion) ||
			(wantKind == OpRefSkip && pos.Kind != KindRefSkip) {
			t.Fatalf("MapRef(%d): 缺口类别错误 kind=%d 期望 op=%d", ref, pos.Kind, wantKind)
		}
		if !(pos.GapStart <= ref && ref < pos.GapEnd) {
			t.Fatalf("MapRef(%d): 缺口区间 [%d,%d) 不含坐标", ref, pos.GapStart, pos.GapEnd)
		}
	}

	for local := uint64(0); local < c.ReadLength(); local++ {
		orig := c.ReadStart + local
		pos, err := c.MapRead(local)
		if err != nil {
			t.Fatalf("MapRead(%d): %v", local, err)
		}
		if anchor, isIns := insertionAnchor(o, orig); isIns {
			if pos.Kind != KindInsertion || pos.RefCoord != anchor {
				t.Fatalf("MapRead(%d): 期望插入锚点 %d，得到 %+v", local, anchor, pos)
			}
			continue
		}
		if pos.Kind != KindAligned {
			t.Fatalf("MapRead(%d): 期望 aligned，得到 %+v", local, pos)
		}
		back, err := c.MapRef(pos.RefCoord)
		if err != nil || back.Kind != KindAligned || back.ReadIndex != local {
			t.Fatalf("MapRef(%d) 回查失败: %+v err=%v", pos.RefCoord, back, err)
		}
	}

	if _, err := c.MapRead(c.ReadLength()); !errors.Is(err, ErrIndexOutOfRange) {
		t.Fatalf("MapRead 越界未报错: %v", err)
	}
	if _, err := c.MapRef(c.RefStart); err != nil {
		t.Fatalf("MapRef 起点报错: %v", err)
	}
	if _, err := c.MapRef(refEnd); !errors.Is(err, ErrCoordOutOfRange) {
		t.Fatalf("MapRef 越界未报错: %v", err)
	}
	if c.RefStart > 0 {
		if _, err := c.MapRef(c.RefStart - 1); !errors.Is(err, ErrCoordOutOfRange) {
			t.Fatalf("MapRef 左侧越界未报错: %v", err)
		}
	}
}
