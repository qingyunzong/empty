package dataeng

import (
	"encoding/binary"
	"testing"
)

// 场景1：无新元数据连续段。第二段仅 reuse，索引与活动顺序全部继承。
func TestContiguousInheritedSegments(t *testing.T) {
	eng, err := New(testBudget())
	if err != nil {
		t.Fatal(err)
	}

	// chunk = [a 2个i16][b 1个i32] = 4+4 = 8 字节，两个 chunk 共 16 字节。
	build := func(valsA []int16, valsB []int32) []byte {
		buf := make([]byte, 16)
		bo := binary.LittleEndian
		for chunk := 0; chunk < 2; chunk++ {
			base := chunk * 8
			bo.PutUint16(buf[base:], uint16(valsA[chunk*2]))
			bo.PutUint16(buf[base+2:], uint16(valsA[chunk*2+1]))
			bo.PutUint32(buf[base+4:], uint32(valsB[chunk]))
		}
		return buf
	}

	raw1 := build([]int16{1, 2, 3, 4}, []int32{10, 20})
	mustIngest(t, eng, rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/dev/a", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 2},
		{Path: "/dev/b", Kind: IndexNew, Type: TypeI32, SamplesPerChunk: 1},
	}, raw1))

	raw2 := build([]int16{5, 6, 7, 8}, []int32{30, 40})
	mustIngest(t, eng, rawSeg(2, LittleEndian, false, LayoutContiguous, []Update{
		{Path: "/dev/a", Kind: IndexReuse},
		{Path: "/dev/b", Kind: IndexReuse},
	}, raw2))

	if got := eng.ActiveOrder(); len(got) != 2 || got[0] != "/dev/a" || got[1] != "/dev/b" {
		t.Fatalf("active order not inherited: %v", got)
	}

	h, err := eng.Open("/dev/a", 0, 8)
	if err != nil {
		t.Fatal(err)
	}
	results := readAll(t, h)
	wantA := []int16{1, 2, 3, 4, 5, 6, 7, 8}
	if len(results) != len(wantA) {
		t.Fatalf("a samples = %d, want %d", len(results), len(wantA))
	}
	for i, r := range results {
		if r.I16 != wantA[i] {
			t.Fatalf("a[%d]=%d want %d", i, r.I16, wantA[i])
		}
		if r.Source.LogicalIndex != int64(i) || r.Source.Width != 2 {
			t.Fatalf("a[%d] bad source = %+v", i, r.Source)
		}
	}
	// 逻辑样本4来自第二段 chunk0，物理偏移0。
	if results[4].Source.SegmentNumber != 2 || results[4].Source.Chunk != 0 || results[4].Source.PhysicalOffset != 0 {
		t.Fatalf("cross segment source = %+v", results[4].Source)
	}

	h2, err := eng.Open("/dev/b", 1, 3)
	if err != nil {
		t.Fatal(err)
	}
	rb := readAll(t, h2)
	if len(rb) != 2 || rb[0].I32 != 20 || rb[1].I32 != 30 {
		t.Fatalf("b range read = %+v", rb)
	}
	// b 块内偏移4；逻辑样本1 = chunk1，物理偏移 8+4=12。
	if rb[0].Source.PhysicalOffset != 12 || rb[0].Source.Chunk != 1 {
		t.Fatalf("b source offset = %+v", rb[0].Source)
	}
}

// 场景2：newList 改变活动顺序，省略路径不参与本段；空 newList 后仍可重入。
func TestNewListReordersAndDrops(t *testing.T) {
	eng, _ := New(testBudget())
	mustIngest(t, eng, rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/x", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 1},
		{Path: "/y", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 1},
	}, []byte{1, 0, 2, 0}))

	// 新顺序 [y, x]，y 现在位于块首。
	mustIngest(t, eng, rawSeg(2, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/y", Kind: IndexReuse},
		{Path: "/x", Kind: IndexReuse},
	}, []byte{5, 0, 6, 0}))

	if got := eng.ActiveOrder(); len(got) != 2 || got[0] != "/y" || got[1] != "/x" {
		t.Fatalf("reordered active = %v", got)
	}
	h, _ := eng.Open("/y", 1, 2)
	r := readAll(t, h)
	if r[0].I16 != 5 || r[0].Source.PhysicalOffset != 0 {
		t.Fatalf("y first in chunk = %+v", r[0])
	}

	// 更新列表为空且 newList=true：活动为空，仅空 raw 可提交，缓存保留。
	mustIngest(t, eng, rawSeg(3, LittleEndian, true, LayoutContiguous, nil, nil))
	if got := eng.ActiveOrder(); len(got) != 0 {
		t.Fatalf("expected empty active order, got %v", got)
	}
	if total, _ := eng.TotalSamples("/x"); total != 2 {
		t.Fatalf("x samples after empty list = %d", total)
	}

	// 缓存仍可 reuse 重入。
	mustIngest(t, eng, rawSeg(4, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/x", Kind: IndexReuse},
	}, []byte{9, 0}))
	h2, _ := eng.Open("/x", 2, 3)
	r2 := readAll(t, h2)
	if r2[0].I16 != 9 {
		t.Fatalf("x after reentry = %d", r2[0].I16)
	}
}

// 场景3：none 暂停通道但保留缓存，随后 reuse 重入，暂停不补零。
func TestNoneThenReuseReentry(t *testing.T) {
	eng, _ := New(testBudget())
	mustIngest(t, eng, rawSeg(1, LittleEndian, false, LayoutContiguous, []Update{
		{Path: "/p", Kind: IndexNew, Type: TypeI32, SamplesPerChunk: 1},
		{Path: "/q", Kind: IndexNew, Type: TypeI32, SamplesPerChunk: 1},
	}, []byte{
		1, 0, 0, 0,
		7, 0, 0, 0,
	}))

	// /q 被 none 移除，本段仅 /p 活动。
	mustIngest(t, eng, rawSeg(2, LittleEndian, false, LayoutContiguous, []Update{
		{Path: "/q", Kind: IndexNone},
	}, []byte{2, 0, 0, 0}))

	if got := eng.ActiveOrder(); len(got) != 1 || got[0] != "/p" {
		t.Fatalf("after none active = %v", got)
	}
	if total, _ := eng.TotalSamples("/q"); total != 1 {
		t.Fatalf("q must keep one sample, got %d", total)
	}

	// reuse 未活动路径按更新顺序追加，/q 重入，逻辑号在旧样本之后继续。
	mustIngest(t, eng, rawSeg(3, LittleEndian, false, LayoutContiguous, []Update{
		{Path: "/q", Kind: IndexReuse},
	}, []byte{
		3, 0, 0, 0,
		8, 0, 0, 0,
	}))
	if got := eng.ActiveOrder(); len(got) != 2 || got[0] != "/p" || got[1] != "/q" {
		t.Fatalf("after reuse active = %v", got)
	}
	h, _ := eng.Open("/q", 0, 2)
	rs := readAll(t, h)
	if rs[0].I32 != 7 || rs[1].I32 != 8 {
		t.Fatalf("q logical continuity = %+v", rs)
	}
	if rs[1].Source.LogicalIndex != 1 || rs[1].Source.SegmentNumber != 3 {
		t.Fatalf("q source = %+v", rs[1].Source)
	}

	// 从未 new 过的路径 reuse 必须拒绝，且不能借用别的路径索引。
	err := eng.Ingest(rawSeg(4, LittleEndian, false, LayoutContiguous, []Update{
		{Path: "/unknown", Kind: IndexReuse},
	}, nil))
	assertReject(t, err, ErrReuseWithoutIndex)
}
