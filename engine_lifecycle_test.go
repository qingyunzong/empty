package dataeng

import (
	"errors"
	"io"
	"math"
	"testing"
)

// 场景6：后续 new 改变 n，旧样本不重分块，逻辑号连续累积。
func TestChangeSamplesPerChunk(t *testing.T) {
	eng, _ := New(testBudget())

	// 段1：i16 n=1，两个 chunk（每 chunk 2 字节）。
	raw1 := []byte{1, 0, 2, 0}
	mustIngest(t, eng, rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/v", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 1},
	}, raw1))

	// 段2：同类型同端序，n 改为 2，一个 chunk 4 字节；类型/端序冲突才拒绝。
	raw2 := []byte{3, 0, 4, 0}
	mustIngest(t, eng, rawSeg(2, LittleEndian, false, LayoutContiguous, []Update{
		{Path: "/v", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 2},
	}, raw2))

	h, _ := eng.Open("/v", 0, 4)
	rs := readAll(t, h)
	want := []int16{1, 2, 3, 4}
	for i, r := range rs {
		if r.I16 != want[i] {
			t.Fatalf("v[%d]=%d want %d", i, r.I16, want[i])
		}
	}
	if rs[2].Source.SegmentNumber != 2 || rs[2].Source.Chunk != 0 {
		t.Fatalf("rechunked sample source = %+v", rs[2].Source)
	}

	// 改类型必须拒绝，且整段不生效。
	err := eng.Ingest(rawSeg(3, LittleEndian, false, LayoutContiguous, []Update{
		{Path: "/v", Kind: IndexNew, Type: TypeI32, SamplesPerChunk: 1},
	}, []byte{0, 0, 0, 0}))
	assertReject(t, err, ErrTypeConflict)

	// 改端序同样拒绝。
	err = eng.Ingest(rawSeg(4, BigEndian, false, LayoutContiguous, []Update{
		{Path: "/v", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 1},
	}, []byte{0, 0}))
	assertReject(t, err, ErrTypeConflict)

	if total, _ := eng.TotalSamples("/v"); total != 4 {
		t.Fatalf("failed segments must not commit samples, got %d", total)
	}
}

// 场景7：空 raw 仍可提交元数据，活动通道存在但零 chunk、零样本。
func TestEmptyRawCommitsMetadata(t *testing.T) {
	eng, _ := New(testBudget())

	// 无 Reader、空原始区：只提交 new 索引，不产出样本。
	mustIngest(t, eng, Segment{
		SegmentNumber: 1,
		Endian:        LittleEndian,
		NewList:       true,
		Layout:        LayoutContiguous,
		Updates: []Update{
			{Path: "/m", Kind: IndexNew, Type: TypeI32, SamplesPerChunk: 3},
		},
	})

	if total, ok := eng.TotalSamples("/m"); !ok || total != 0 {
		t.Fatalf("metadata-only path total = %d,%v", total, ok)
	}
	if got := eng.ActiveOrder(); len(got) != 1 || got[0] != "/m" {
		t.Fatalf("metadata-only active order = %v", got)
	}

	// 空区间合法；非空区间越界在读取前拒绝。
	h, err := eng.Open("/m", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if rs, err := h.ReadAll(); err != nil || len(rs) != 0 {
		t.Fatalf("empty range read = %d,%v", len(rs), err)
	}
	_, err = eng.Open("/m", 0, 1)
	assertReject(t, err, ErrRange)

	// 下一段直接 reuse 段1建立的缓存并带真实 raw。
	mustIngest(t, eng, rawSeg(2, LittleEndian, false, LayoutContiguous, []Update{
		{Path: "/m", Kind: IndexReuse},
	}, []byte{7, 0, 0, 0, 8, 0, 0, 0, 9, 0, 0, 0}))
	h2, _ := eng.Open("/m", 0, 3)
	rs := readAll(t, h2)
	if len(rs) != 3 || rs[0].I32 != 7 || rs[2].I32 != 9 {
		t.Fatalf("post-empty reuse samples = %+v", rs)
	}

	// 活动为空却带非空 raw 必须拒绝。
	err = eng.Ingest(rawSeg(3, LittleEndian, true, LayoutContiguous, nil, []byte{1}))
	assertReject(t, err, ErrRawLayout)
}

// 场景8：坏 raw 整段不生效，修正后用原段号重试，不产生重复样本。
func TestFailedSegmentRetrySameNumber(t *testing.T) {
	eng, _ := New(testBudget())
	mustIngest(t, eng, rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/r", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 2},
	}, []byte{1, 0, 2, 0}))

	good := []byte{3, 0, 4, 0}

	// 短尾：3 字节不是 chunk 字节数 4 的整数倍，段2拒绝且不占段号。
	bad := Segment{
		SegmentNumber: 2,
		Endian:        LittleEndian,
		NewList:       false,
		Layout:        LayoutContiguous,
		Updates:       []Update{{Path: "/r", Kind: IndexReuse}},
		Reader:        newBytesReader([]byte{3, 0, 4}),
		RawLength:     3,
	}
	err := eng.Ingest(bad)
	assertReject(t, err, ErrRawLayout)

	if total, _ := eng.TotalSamples("/r"); total != 2 {
		t.Fatalf("failed segment changed total to %d", total)
	}

	// 原段号重试成功。
	mustIngest(t, eng, Segment{
		SegmentNumber: 2,
		Endian:        LittleEndian,
		NewList:       false,
		Layout:        LayoutContiguous,
		Updates:       []Update{{Path: "/r", Kind: IndexReuse}},
		Reader:        newBytesReader(good),
		RawLength:     int64(len(good)),
	})

	// 已提交段号再次输入一律拒绝。
	err = eng.Ingest(rawSeg(2, LittleEndian, false, LayoutContiguous, []Update{
		{Path: "/r", Kind: IndexReuse},
	}, good))
	assertReject(t, err, ErrDuplicateSegment)

	h, _ := eng.Open("/r", 0, 4)
	rs := readAll(t, h)
	if len(rs) != 4 || rs[2].I16 != 3 || rs[3].I16 != 4 {
		t.Fatalf("retry samples = %+v", rs)
	}
	// 确认没有重复样本：逻辑号严格 0..3。
	for i, r := range rs {
		if r.Source.LogicalIndex != int64(i) {
			t.Fatalf("duplicate/hole logical index at %d: %+v", i, r.Source)
		}
	}
}

func newBytesReader(b []byte) io.ReaderAt {
	return &byteReaderAt{data: b}
}

type byteReaderAt struct{ data []byte }

func (r *byteReaderAt) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 || off >= int64(len(r.data)) {
		return 0, io.EOF
	}
	n := copy(p, r.data[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func TestBudgetsAndDuplicatePath(t *testing.T) {
	eng, err := New(Budget{MaxChannelsPerSegment: 1, MaxChunksPerSegment: 2, MaxCachedIndexes: 4})
	if err != nil {
		t.Fatal(err)
	}

	// 同段重复路径拒绝。
	err = eng.Ingest(rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/a", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 1},
		{Path: "/a", Kind: IndexNone},
	}, nil))
	assertReject(t, err, ErrDuplicatePath)

	// 超单段通道预算拒绝。
	err = eng.Ingest(rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/a", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 1},
		{Path: "/b", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 1},
	}, []byte{0, 0, 0, 0}))
	assertReject(t, err, ErrBudgetExceeded)

	// 超 chunk 预算拒绝（n=1，每个 chunk 2 字节，3 个 chunk）。
	err = eng.Ingest(rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/a", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 1},
	}, []byte{0, 0, 0, 0, 0, 0}))
	assertReject(t, err, ErrBudgetExceeded)

	// 索引缓存预算：预算4，建立5条新路径拒绝。
	small, _ := New(Budget{MaxChannelsPerSegment: 8, MaxChunksPerSegment: 2, MaxCachedIndexes: 4})
	updates := make([]Update, 0, 5)
	raw := make([]byte, 10)
	for i := 0; i < 5; i++ {
		updates = append(updates, Update{
			Path:            string(rune('a' + i)),
			Kind:            IndexNew,
			Type:            TypeI16,
			SamplesPerChunk: 1,
		})
	}
	err = small.Ingest(rawSeg(1, LittleEndian, true, LayoutContiguous, updates, raw))
	assertReject(t, err, ErrBudgetExceeded)
}

func TestAddressOverflowRejectedBeforeRead(t *testing.T) {
	eng, _ := New(Budget{MaxChannelsPerSegment: 4, MaxChunksPerSegment: math.MaxInt64, MaxCachedIndexes: 4})
	// n 接近 MaxInt64，单 chunk 字节数乘法在读取前溢出，且没有提供任何 Reader。
	err := eng.Ingest(Segment{
		SegmentNumber: 1,
		Endian:        LittleEndian,
		NewList:       true,
		Layout:        LayoutInterleaved,
		Updates: []Update{
			{Path: "/big", Kind: IndexNew, Type: TypeTimestamp, SamplesPerChunk: math.MaxInt64 / 2},
			{Path: "/big2", Kind: IndexNew, Type: TypeTimestamp, SamplesPerChunk: math.MaxInt64 / 2},
		},
	})
	if err == nil || !errors.Is(err, ErrAddressOverflow) {
		t.Fatalf("expected overflow before read, got %v", err)
	}
}

func TestPhysicalOffsetIncludesRawOffset(t *testing.T) {
	eng, _ := New(testBudget())
	window := make([]byte, 4098)
	window[4096] = 0xAB
	window[4097] = 0xCD
	mustIngest(t, eng, Segment{
		SegmentNumber: 1,
		Endian:        BigEndian,
		NewList:       true,
		Layout:        LayoutContiguous,
		Updates:       []Update{{Path: "/off", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 1}},
		Reader:        newBytesReader(window),
		RawOffset:     4096,
		RawLength:     2,
	})
	h, _ := eng.Open("/off", 0, 1)
	rs := readAll(t, h)
	if rs[0].I16 != -21555 {
		t.Fatalf("big endian decode = %d", rs[0].I16)
	}
	if rs[0].Source.PhysicalOffset != 4096 {
		t.Fatalf("physical offset = %d", rs[0].Source.PhysicalOffset)
	}
}

func TestInvalidBudgetAndReadRange(t *testing.T) {
	if _, err := New(Budget{}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("zero budget err = %v", err)
	}
	eng, _ := New(testBudget())
	mustIngest(t, eng, rawSeg(1, LittleEndian, true, LayoutContiguous, []Update{
		{Path: "/z", Kind: IndexNew, Type: TypeI16, SamplesPerChunk: 1},
	}, []byte{1, 0}))

	if _, err := eng.Open("/nope", 0, 1); !errors.Is(err, ErrUnknownPath) {
		t.Fatalf("unknown path err = %v", err)
	}
	if _, err := eng.Open("/z", -1, 1); !errors.Is(err, ErrRange) {
		t.Fatalf("negative start err = %v", err)
	}
	if _, err := eng.Open("/z", 1, 0); !errors.Is(err, ErrRange) {
		t.Fatalf("reversed range err = %v", err)
	}
	if _, err := eng.Open("/z", 0, 5); !errors.Is(err, ErrRange) {
		t.Fatalf("overrun err = %v", err)
	}

	// 空更新 + newList=false：活动顺序与索引全部继承。
	mustIngest(t, eng, Segment{
		SegmentNumber: 2,
		Endian:        LittleEndian,
		NewList:       false,
		Layout:        LayoutContiguous,
	})
	if got := eng.ActiveOrder(); len(got) != 1 || got[0] != "/z" {
		t.Fatalf("empty update inheritance = %v", got)
	}
}
