package dataeng

import (
	"math/big"
	"testing"
)

// pqFixture 构造含固定 I、非字节对齐 X、P 变长 B 与 Q 变长 J 的表：
// 2 行、行宽 32、显式堆起点 H=64（行区 0..63 之后留空），表末 128。
type pqFixture struct {
	buf   []byte
	cfg   Config
	guard *guardReader
}

const (
	pqW        int64 = 32
	pqR        int64 = 2
	pqH        int64 = 64
	pqP        int64 = 64
	pqTableEnd       = pqW*pqR + pqP
)

func buildPQFixture(t *testing.T) pqFixture {
	t.Helper()
	buf := make([]byte, pqTableEnd)

	// 行 0：固定 I；固定 X=13 bit；P B 4 元素；Q J 3 元素。
	putAt(buf, 0, be16(0x0102))
	putAt(buf, 2, []byte{0b10110000, 0b01000000})
	putAt(buf, 4, descP(4, 0))
	putAt(buf, 16, descQ(3, 16))
	// 行 1：P 零长且 offset 故意为负（必须被忽略）；Q 复行行 0 的 J 堆。
	putAt(buf, int(pqW)+4, descP(0, -7))
	putAt(buf, int(pqW)+16, descQ(3, 16))

	// 堆（H=64）：B 区 4 字节；J 区位于 offset 16，占 3*4 字节。
	putAt(buf, int(pqH), []byte{10, 20, 30, 40})
	putAt(buf, int(pqH)+16, be32(-1000), be32(2), be32(1000000))

	guard := &guardReader{inner: newMemReader(buf), tableEnd: pqTableEnd}
	cfg := Config{
		Reader:      guard,
		DataLength:  pqTableEnd + 16, // 末尾另有 16 字节，不得被读取
		RowWidth:    pqW,
		RowCount:    pqR,
		ExtraBytes:  pqP,
		HeapStart:   pqH,
		MaxElements: 1 << 20,
		Columns: []Column{
			{Name: "i", Offset: 0, Type: TypeI, Desc: DescFixed, FixedCount: 1},
			{Name: "x", Offset: 2, Type: TypeX, Desc: DescFixed, FixedCount: 13},
			{Name: "pb", Offset: 4, Type: TypeB, Desc: DescP},
			{Name: "qj", Offset: 16, Type: TypeJ, Desc: DescQ},
		},
	}
	return pqFixture{buf: buf, cfg: cfg, guard: guard}
}

func TestPQDescriptorsAndDecoding(t *testing.T) {
	fx := buildPQFixture(t)
	table, err := New(fx.cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := table.HeapStart(); got != pqH {
		t.Fatalf("heap start = %d, want %d", got, pqH)
	}

	batch, err := table.ReadBatch([]int64{0, 1}, []string{"i", "x", "pb", "qj"})
	if err != nil {
		t.Fatalf("ReadBatch: %v", err)
	}
	if len(batch.Arrays) != 8 {
		t.Fatalf("got %d arrays, want 8", len(batch.Arrays))
	}

	if got := batch.Arrays[0].I16; len(got) != 1 || got[0] != 0x0102 {
		t.Fatalf("fixed I decode = %v", got)
	}
	wantBits := []bool{true, false, true, true, false, false, false, false, false, true, false, false, false}
	gotBits := batch.Arrays[1].Bits
	if len(gotBits) != 13 {
		t.Fatalf("X length = %d", len(gotBits))
	}
	for i := range wantBits {
		if gotBits[i] != wantBits[i] {
			t.Fatalf("X bit %d = %v, want %v", i, gotBits[i], wantBits[i])
		}
	}

	pb0 := batch.Arrays[2]
	if got := pb0.U8; len(got) != 4 || got[0] != 10 || got[3] != 40 {
		t.Fatalf("P B row0 = %v", got)
	}
	if pb0.Source != (Range{Offset: pqH, Length: 4}) {
		t.Fatalf("P B source = %+v", pb0.Source)
	}
	qj0 := batch.Arrays[3]
	if got := qj0.I32; len(got) != 3 || got[0] != -1000 || got[2] != 1000000 {
		t.Fatalf("Q J row0 = %v", got)
	}
	if qj0.Source != (Range{Offset: pqH + 16, Length: 12}) {
		t.Fatalf("Q J source = %+v", qj0.Source)
	}

	// 行 1：P 零长（负 offset 被忽略，不得报错）。
	pb1 := batch.Arrays[6]
	if pb1.Len() != 0 || pb1.Source != (Range{}) {
		t.Fatalf("zero-length P = %+v", pb1)
	}
	// 行 1 Q 与行 0 Q 引用完全相同的物理范围。
	qj1 := batch.Arrays[7]
	if qj1.Source != qj0.Source {
		t.Fatalf("Q sources differ: %+v vs %+v", qj1.Source, qj0.Source)
	}

	readCount := map[Range]int{}
	for _, call := range batch.Reads.Calls {
		readCount[Range{call.Offset, call.Length}]++
		if call.Offset+call.Length > pqTableEnd {
			t.Fatalf("read escaped table: %+v", call)
		}
	}
	if readCount[Range{pqH + 16, 12}] != 1 {
		t.Fatalf("shared J range read %d times, want 1", readCount[Range{pqH + 16, 12}])
	}
	if readCount[Range{pqH, 4}] != 1 {
		t.Fatalf("B range read count = %d", readCount[Range{pqH, 4}])
	}

	// 输出数组必须独立：修改副本不得影响另一数组。
	pb0.U8[0] = 99
	if batch.Arrays[6].Len() != 0 {
		t.Fatal("unexpected mutation across arrays")
	}
	if qj1.I32[0] != -1000 {
		t.Fatal("shared decode must still produce independent slices")
	}
}

func TestNullThenScaling(t *testing.T) {
	const W = int64(12)
	buf := make([]byte, W)
	putAt(buf, 0, be32(4), be32(-1), be32(10)) // 哨兵 -1 表示 NULL
	cfg := Config{
		Reader: newMemReader(buf), DataLength: W, RowWidth: W, RowCount: 1,
		MaxElements: 8,
		Columns: []Column{{
			Name: "j", Offset: 0, Type: TypeJ, Desc: DescFixed, FixedCount: 3,
			NullSentinel: i64ptr(-1), Scale: big.NewRat(1, 2), Zero: big.NewRat(3, 1),
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
	values := batch.Arrays[0].Values
	if len(values) != 3 {
		t.Fatalf("values len = %d", len(values))
	}
	if values[0].Cmp(big.NewRat(5, 1)) != 0 {
		t.Fatalf("scaled[0] = %v, want 5", values[0])
	}
	if values[1] != nil {
		t.Fatalf("NULL slot = %v, want nil", values[1])
	}
	if values[2].Cmp(big.NewRat(8, 1)) != 0 {
		t.Fatalf("scaled[2] = %v, want 8", values[2])
	}
}
