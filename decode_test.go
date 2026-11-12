package dataeng

import (
	"errors"
	"math/big"
	"testing"
)

func TestVariableKAXAndFixedA(t *testing.T) {
	const W, R, H = int64(32), int64(1), int64(32)
	// 行内：Q K 描述符（16B，偏移0）、P A 描述符（8B，偏移16）、
	// P X 描述符（8B，偏移24）。
	buf := make([]byte, 64)
	putAt(buf, 0, descQ(2, 0))    // K: 2*8 字节，堆偏移 0
	putAt(buf, 16, descP(3, 16))  // A: 3 字节，堆偏移 16
	putAt(buf, 24, descP(11, 24)) // X: 11 bit -> 2 字节，堆偏移 24

	putAt(buf, int(H), be64(1<<40), be64(-(1 << 40)))
	putAt(buf, int(H)+16, []byte{'a', 'b', 'c'})
	putAt(buf, int(H)+24, []byte{0b11001010, 0b10000000})

	cfg := Config{
		Reader:     &guardReader{inner: newMemReader(buf), tableEnd: 64},
		DataLength: 64, RowWidth: W, RowCount: R, ExtraBytes: 32, HeapStart: H,
		MaxElements: 64,
		Columns: []Column{
			{Name: "k", Offset: 0, Type: TypeK, Desc: DescQ},
			{Name: "a", Offset: 16, Type: TypeA, Desc: DescP},
			{Name: "x", Offset: 24, Type: TypeX, Desc: DescP},
		},
	}
	table, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	batch, err := table.ReadBatch([]int64{0}, []string{"k", "a", "x"})
	if err != nil {
		t.Fatalf("ReadBatch: %v", err)
	}

	k := batch.Arrays[0]
	if len(k.I64) != 2 || k.I64[0] != 1<<40 || k.I64[1] != -(1<<40) {
		t.Fatalf("K decode = %v", k.I64)
	}
	if k.Source != (Range{Offset: H, Length: 16}) {
		t.Fatalf("K source = %+v", k.Source)
	}
	a := batch.Arrays[1]
	if string(a.Bytes) != "abc" {
		t.Fatalf("A decode = %q", a.Bytes)
	}
	x := batch.Arrays[2]
	want := []bool{true, true, false, false, true, false, true, false, true, false, false}
	if len(x.Bits) != 11 {
		t.Fatalf("X len = %d", len(x.Bits))
	}
	for i := range want {
		if x.Bits[i] != want[i] {
			t.Fatalf("X bit %d = %v want %v", i, x.Bits[i], want[i])
		}
	}
	if x.Source.Length != 2 { // ceil(11/8)
		t.Fatalf("X byte width = %d, want 2", x.Source.Length)
	}
}

func TestAccessorsAndEmptyRequests(t *testing.T) {
	fx := buildPQFixture(t)
	table, err := New(fx.cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if table.RowWidth() != pqW || table.RowCount() != pqR || table.TableEnd() != pqTableEnd {
		t.Fatal("geometry accessors mismatch")
	}
	col, idx, ok := table.Column("pb")
	if !ok || idx != 2 || col.Name != "pb" {
		t.Fatalf("Column lookup = %+v %d %v", col, idx, ok)
	}
	if _, _, ok := table.Column("missing"); ok {
		t.Fatal("missing column should not be found")
	}

	batch, err := table.ReadBatch(nil, []string{"pb"})
	if err != nil || len(batch.Arrays) != 0 {
		t.Fatalf("empty rows = %v %v", err, batch.Arrays)
	}
	batch, err = table.ReadBatch([]int64{0}, nil)
	if err != nil || len(batch.Arrays) != 0 {
		t.Fatalf("empty columns = %v %v", err, batch.Arrays)
	}
}

func TestReadErrorPropagatesAsShortRead(t *testing.T) {
	const W, H = int64(16), int64(16)
	buf := make([]byte, 24)
	putAt(buf, 0, descP(2, 0))
	reader := newMemReader(buf)
	reader.failAt = 0 // 描述符读取即失败
	cfg := Config{
		Reader: reader, DataLength: 24, RowWidth: W, RowCount: 1,
		ExtraBytes: 8, HeapStart: H, MaxElements: 8,
		Columns: []Column{{Name: "p", Offset: 0, Type: TypeB, Desc: DescP}},
	}
	table, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = table.ReadBatch([]int64{0}, []string{"p"})
	if !errors.Is(err, ErrShortRead) {
		t.Fatalf("err = %v, want ErrShortRead", err)
	}
}

func TestCrossBatchIndependence(t *testing.T) {
	const W, R = int64(4), int64(1)
	buf := make([]byte, W*R)
	putAt(buf, 0, be32(123))
	cfg := Config{
		Reader: newMemReader(buf), DataLength: int64(len(buf)), RowWidth: W, RowCount: R,
		MaxElements: 8,
		Columns:     []Column{{Name: "j", Offset: 0, Type: TypeJ, Desc: DescFixed, FixedCount: 1}},
	}
	table, _ := New(cfg)
	first, err := table.ReadBatch([]int64{0}, []string{"j"})
	if err != nil {
		t.Fatal(err)
	}
	first.Arrays[0].I32[0] = -1
	second, err := table.ReadBatch([]int64{0}, []string{"j"})
	if err != nil {
		t.Fatal(err)
	}
	if second.Arrays[0].I32[0] != 123 {
		t.Fatal("mutation leaked across batches")
	}
}

func TestLenAcrossTypes(t *testing.T) {
	if (Array{U8: make([]uint8, 2)}).Len() != 2 {
		t.Fatal("U8 Len")
	}
	if (Array{I16: make([]int16, 1)}).Len() != 1 {
		t.Fatal("I16 Len")
	}
	if (Array{I32: make([]int32, 1)}).Len() != 1 {
		t.Fatal("I32 Len")
	}
	if (Array{I64: make([]int64, 1)}).Len() != 1 {
		t.Fatal("I64 Len")
	}
	if (Array{Bytes: make([]byte, 1)}).Len() != 1 {
		t.Fatal("Bytes Len")
	}
	if (Array{Bits: make([]bool, 1)}).Len() != 1 {
		t.Fatal("Bits Len")
	}
	if (Array{Values: make([]*big.Rat, 0)}).Len() != 0 {
		t.Fatal("empty Values Len")
	}
	if (Array{}).Len() != 0 {
		t.Fatal("zero Array Len")
	}
}

func TestDefensiveConfigErrors(t *testing.T) {
	goodReader := newMemReader(make([]byte, 16))
	if _, err := New(Config{}); !errors.Is(err, ErrConfig) {
		t.Fatalf("nil reader err = %v", err)
	}

	base := func() Config {
		return Config{
			Reader: goodReader, DataLength: 16, RowWidth: 8, RowCount: 1,
			MaxElements: 4,
			Columns:     []Column{{Name: "b", Offset: 0, Type: TypeB, Desc: DescFixed, FixedCount: 1}},
		}
	}

	cfg := base()
	cfg.Columns[0].Type = 'Z'
	if _, err := New(cfg); !errors.Is(err, ErrConfig) {
		t.Fatalf("unknown type err = %v", err)
	}

	cfg = base()
	cfg.Columns[0].Desc = 'Y'
	if _, err := New(cfg); !errors.Is(err, ErrConfig) {
		t.Fatalf("unknown desc err = %v", err)
	}

	cfg = base()
	cfg.Columns[0].Name = ""
	if _, err := New(cfg); !errors.Is(err, ErrConfig) {
		t.Fatalf("empty name err = %v", err)
	}

	cfg = base()
	cfg.Columns = nil
	if _, err := New(cfg); !errors.Is(err, ErrConfig) {
		t.Fatalf("no columns err = %v", err)
	}

	cfg = base()
	cfg.DataLength = -1
	if _, err := New(cfg); !errors.Is(err, ErrConfig) {
		t.Fatalf("negative length err = %v", err)
	}
}

func TestFixedColumnOutOfTableRejected(t *testing.T) {
	// 行宽足够放下列，但行区末尾超出表区间（R 与数据长度制造矛盾）。
	cfg := Config{
		Reader: newMemReader(make([]byte, 4)), DataLength: 4,
		RowWidth: 8, RowCount: 1, MaxElements: 4,
		Columns: []Column{{Name: "j", Offset: 0, Type: TypeJ, Desc: DescFixed, FixedCount: 1}},
	}
	// New 阶段即因 W*R > DataLength 拒绝。
	if _, err := New(cfg); !errors.Is(err, ErrAddressing) {
		t.Fatalf("err = %v, want ErrAddressing", err)
	}
}
