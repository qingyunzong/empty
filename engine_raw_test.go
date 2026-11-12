package dataeng

import "testing"

func TestShortTailRejected(t *testing.T) {
	eng, _ := New(testBudget())

	// contiguous：chunk 4 字节，3 字节是短尾。
	err := eng.Ingest(rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/s", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 2},
	}, []byte{1, 2, 3}))
	assertReject(t, err, ErrRawLayout)

	// 失败段不占段号，原号可重试成功。
	mustIngest(t, eng, rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/s", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 2},
	}, []byte{1, 2, 3, 4}))

	// interleaved：两通道 i16，stride 4，n=2，chunk 8 字节；给 10 字节留 2 字节短尾。
	err = eng.Ingest(rawSeg(2, LittleEndian, true, LayoutInterleaved, []Update{
		{Path: "/a", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 2},
		{Path: "/b", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 2},
	}, make([]byte, 10)))
	assertReject(t, err, ErrRawLayout)

	// 活动为空但带非空 raw 拒绝。
	err = eng.Ingest(rawSeg(3, LittleEndian, true, LayoutContiguous, nil, []byte{0}))
	assertReject(t, err, ErrRawLayout)
}

func TestEmptyUpdateInheritance(t *testing.T) {
	eng, _ := New(testBudget())
	mustIngest(t, eng, rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/keep", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 1},
	}, []byte{5, 0}))

	// 空更新 + newList=false + 空 raw：活动顺序与索引全部继承，零新样本。
	mustIngest(t, eng, Segment{
		SegmentNumber: 2,
		Endian:        LittleEndian,
		NewList:       false,
		Layout:        LayoutContiguous,
	})
	if got := eng.ActiveOrder(); len(got) != 1 || got[0] != "/keep" {
		t.Fatalf("inheritance active = %v", got)
	}
	if total, _ := eng.TotalSamples("/keep"); total != 1 {
		t.Fatalf("inheritance total = %d", total)
	}

	// 空更新 + newList=true：活动为空，缓存仍在。
	mustIngest(t, eng, Segment{
		SegmentNumber: 3,
		Endian:        LittleEndian,
		NewList:       true,
		Layout:        LayoutContiguous,
	})
	if got := eng.ActiveOrder(); len(got) != 0 {
		t.Fatalf("newList empty active = %v", got)
	}
	mustIngest(t, eng, rawSeg(4, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/keep", Kind: IndexReuse},
	}, []byte{9, 0}))
	h, _ := eng.Open("/keep", 1, 2)
	rs := readAll(t, h)
	if rs[0].I16 != 9 || rs[0].Source.SegmentNumber != 4 {
		t.Fatalf("reuse after empty newList = %+v", rs)
	}
}
