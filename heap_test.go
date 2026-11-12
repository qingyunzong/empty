package dataeng

import (
	"errors"
	"testing"
)

func TestZeroLengthNegativeOffsetIgnored(t *testing.T) {
	fx := buildPQFixture(t)
	table, err := New(fx.cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	batch, err := table.ReadBatch([]int64{1}, []string{"pb"})
	if err != nil {
		t.Fatalf("zero count with negative offset must be allowed: %v", err)
	}
	if batch.Arrays[0].Len() != 0 {
		t.Fatalf("want empty array, got %d", batch.Arrays[0].Len())
	}
}

func TestOverlappingDescriptorsAreNotCorruption(t *testing.T) {
	const W, R, H = int64(24), int64(1), int64(24)
	buf := make([]byte, 32)
	putAt(buf, 0, descP(4, 0))  // 列 a：堆 [24,28)
	putAt(buf, 8, descP(4, 0))  // 列 b：同一范围
	putAt(buf, 16, descP(2, 1)) // 列 c：重叠但不同的范围 [25,27)
	putAt(buf, int(H), []byte{1, 2, 3, 4})
	guard := &guardReader{inner: newMemReader(buf), tableEnd: 32}
	cfg := Config{
		Reader: guard, DataLength: 32, RowWidth: W, RowCount: R,
		ExtraBytes: 8, HeapStart: H, MaxElements: 64,
		Columns: []Column{
			{Name: "a", Offset: 0, Type: TypeB, Desc: DescP},
			{Name: "b", Offset: 8, Type: TypeB, Desc: DescP},
			{Name: "c", Offset: 16, Type: TypeB, Desc: DescP},
		},
	}
	table, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	batch, err := table.ReadBatch([]int64{0}, []string{"a", "b", "c"})
	if err != nil {
		t.Fatalf("overlap must be legal: %v", err)
	}
	if batch.Arrays[0].Source != batch.Arrays[1].Source {
		t.Fatal("identical ranges not shared")
	}
	seen := map[Range]int{}
	for _, call := range batch.Reads.Calls {
		seen[Range{call.Offset, call.Length}]++
	}
	if seen[Range{24, 4}] != 1 {
		t.Fatalf("identical range read %d times", seen[Range{24, 4}])
	}
	if seen[Range{25, 2}] != 1 {
		t.Fatalf("overlapping distinct range read %d times", seen[Range{25, 2}])
	}
	if got := batch.Arrays[2].U8; len(got) != 2 || got[0] != 2 || got[1] != 3 {
		t.Fatalf("overlap slice = %v", got)
	}
}

func TestExplicitHeapStartLeavesGap(t *testing.T) {
	const W, R = int64(16), int64(1)
	const H = W*R + 8 // 行区与堆之间留 8 字节空隙
	buf := make([]byte, H+4)
	putAt(buf, 0, descP(2, 0))
	putAt(buf, int(H), []byte{7, 9})
	guard := &guardReader{inner: newMemReader(buf), tableEnd: int64(len(buf))}
	cfg := Config{
		Reader: guard, DataLength: int64(len(buf)), RowWidth: W, RowCount: R,
		ExtraBytes: 12, HeapStart: H, MaxElements: 16,
		Columns: []Column{{Name: "p", Offset: 0, Type: TypeB, Desc: DescP}},
	}
	table, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if table.HeapStart() != H {
		t.Fatalf("heap = %d, want %d", table.HeapStart(), H)
	}
	batch, err := table.ReadBatch([]int64{0}, []string{"p"})
	if err != nil {
		t.Fatalf("ReadBatch: %v", err)
	}
	if got := batch.Arrays[0].U8; len(got) != 2 || got[0] != 7 || got[1] != 9 {
		t.Fatalf("heap through gap = %v", got)
	}
	for _, call := range batch.Reads.Calls {
		if call.Offset >= W*R && call.Offset < H {
			t.Fatalf("gap byte range was read: %+v", call)
		}
	}
}

func TestNullSentinelWithoutScaling(t *testing.T) {
	const W = int64(8)
	buf := make([]byte, W)
	putAt(buf, 0, be32(42), be32(-9))
	cfg := Config{
		Reader: newMemReader(buf), DataLength: W, RowWidth: W, RowCount: 1, MaxElements: 8,
		Columns: []Column{{
			Name: "j", Offset: 0, Type: TypeJ, Desc: DescFixed, FixedCount: 2,
			NullSentinel: i64ptr(-9),
		}},
	}
	table, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	batch, err := table.ReadBatch([]int64{0}, []string{"j"})
	if err != nil {
		t.Fatalf("ReadBatch: %v", err)
	}
	arr := batch.Arrays[0]
	if arr.I32[0] != 42 || arr.I32[1] != -9 {
		t.Fatalf("raw values = %v", arr.I32)
	}
	if len(arr.Nulls) != 2 || arr.Nulls[0] || !arr.Nulls[1] {
		t.Fatalf("nulls = %v", arr.Nulls)
	}
}

func TestRowOrderDuplicatesAndIndependentCopies(t *testing.T) {
	const W, R = int64(4), int64(3)
	buf := make([]byte, W*R)
	putAt(buf, int(W*0), be32(10))
	putAt(buf, int(W*1), be32(20))
	putAt(buf, int(W*2), be32(30))
	cfg := Config{
		Reader: newMemReader(buf), DataLength: int64(len(buf)), RowWidth: W, RowCount: R,
		MaxElements: 32,
		Columns:     []Column{{Name: "j", Offset: 0, Type: TypeJ, Desc: DescFixed, FixedCount: 1}},
	}
	table, _ := New(cfg)
	rows := []int64{2, 0, 2, 1} // 乱序 + 重复
	batch, err := table.ReadBatch(rows, []string{"j", "j"})
	if err != nil {
		t.Fatalf("ReadBatch: %v", err)
	}
	want := []int32{30, 30, 10, 10, 30, 30, 20, 20}
	if len(batch.Arrays) != len(want) {
		t.Fatalf("arrays = %d, want %d", len(batch.Arrays), len(want))
	}
	for i, v := range want {
		if batch.Arrays[i].I32[0] != v {
			t.Fatalf("array %d = %d, want %d", i, batch.Arrays[i].I32[0], v)
		}
		if batch.Arrays[i].Row != rows[i/2] {
			t.Fatalf("array %d row metadata wrong", i)
		}
	}
	// 修改一个结果切片不得影响其他结果。
	batch.Arrays[0].I32[0] = -1
	if batch.Arrays[4].I32[0] != 30 {
		t.Fatal("arrays are not independent copies")
	}
}

func TestShortReadDeliversNothing(t *testing.T) {
	fx := buildPQFixture(t)
	reader := fx.guard.inner
	reader.limit = 2 // 每次 ReadAt 最多给 2 字节
	table, err := New(fx.cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = table.ReadBatch([]int64{0}, []string{"qj"})
	if !errors.Is(err, ErrShortRead) {
		t.Fatalf("err = %v, want ErrShortRead", err)
	}
}

func TestDoesNotReadWholeTable(t *testing.T) {
	fx := buildPQFixture(t)
	table, err := New(fx.cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	before := fx.guard.inner.callCount()
	batch, err := table.ReadBatch([]int64{0}, []string{"pb"})
	if err != nil {
		t.Fatalf("ReadBatch: %v", err)
	}
	if fx.guard.inner.callCount() == before {
		t.Fatal("expected some reads")
	}
	if batch.Reads.TotalBytes() >= pqTableEnd {
		t.Fatalf("read %d bytes, must stay far below table size %d", batch.Reads.TotalBytes(), pqTableEnd)
	}
}
