package dataeng

import (
	"errors"
	"math"
	"math/big"
	"testing"
)

func TestNegativeCountAndOffsetRejected(t *testing.T) {
	const W, H = int64(16), int64(16)

	t.Run("negative count", func(t *testing.T) {
		buf := make([]byte, 24)
		putAt(buf, 0, descP(-1, 0))
		cfg := Config{
			Reader: newMemReader(buf), DataLength: 24, RowWidth: W, RowCount: 1,
			ExtraBytes: 8, HeapStart: H, MaxElements: 16,
			Columns: []Column{{Name: "p", Offset: 0, Type: TypeB, Desc: DescP}},
		}
		table, err := New(cfg)
		if err != nil {
			t.Fatalf("New: %v", err)
		}
		_, err = table.ReadBatch([]int64{0}, []string{"p"})
		if !errors.Is(err, ErrDescriptor) {
			t.Fatalf("err = %v, want ErrDescriptor", err)
		}
	})

	t.Run("negative offset with nonzero count", func(t *testing.T) {
		buf := make([]byte, 24)
		putAt(buf, 0, descP(1, -3))
		cfg := Config{
			Reader: newMemReader(buf), DataLength: 24, RowWidth: W, RowCount: 1,
			ExtraBytes: 8, HeapStart: H, MaxElements: 16,
			Columns: []Column{{Name: "p", Offset: 0, Type: TypeB, Desc: DescP}},
		}
		table, _ := New(cfg)
		_, err := table.ReadBatch([]int64{0}, []string{"p"})
		if !errors.Is(err, ErrDescriptor) {
			t.Fatalf("err = %v, want ErrDescriptor", err)
		}
	})
}

func Test64BitHeapOutOfRange(t *testing.T) {
	const W, H = int64(16), int64(16)
	buf := make([]byte, 32)
	// Q 描述符：offset 极大，H+offset 溢出/越过表末，必须拒绝且不交付。
	putAt(buf, 0, descQ(2, math.MaxInt64-7))
	cfg := Config{
		Reader: newMemReader(buf), DataLength: 32, RowWidth: W, RowCount: 1,
		ExtraBytes: 16, HeapStart: H, MaxElements: 64,
		Columns: []Column{{Name: "q", Offset: 0, Type: TypeK, Desc: DescQ}},
	}
	table, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = table.ReadBatch([]int64{0}, []string{"q"})
	if !errors.Is(err, ErrAddressing) {
		t.Fatalf("err = %v, want ErrAddressing", err)
	}
}

func Test64BitFixedColumnWidthOverflow(t *testing.T) {
	cfg := Config{
		Reader: newMemReader([]byte{0}), DataLength: 1, RowWidth: 8, RowCount: 0,
		MaxElements: 8,
		Columns: []Column{{
			Name: "k", Offset: 0, Type: TypeK, Desc: DescFixed, FixedCount: math.MaxInt64,
		}},
	}
	_, err := New(cfg)
	if !errors.Is(err, ErrConfig) && !errors.Is(err, ErrAddressing) {
		t.Fatalf("err = %v, want config/addressing error", err)
	}
}

func TestBudgetRejectedBeforeDataRead(t *testing.T) {
	fx := buildPQFixture(t)
	fx.cfg.MaxElements = 3 // 行0 pb 单是 4 元素即超预算
	table, err := New(fx.cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	before := fx.guard.inner.callCount()
	_, err = table.ReadBatch([]int64{0}, []string{"pb"})
	if !errors.Is(err, ErrBudget) {
		t.Fatalf("err = %v, want ErrBudget", err)
	}
	// 预算在交付前判定；描述符读取可能已发生，但堆数据读取不应发生。
	for _, call := range fx.guard.inner.calls[before:] {
		if call.Offset >= pqH {
			t.Fatalf("heap read happened before budget rejection: %+v", call)
		}
	}
}

func TestConfigValidation(t *testing.T) {
	base := func() Config {
		return Config{
			Reader: newMemReader(make([]byte, 32)), DataLength: 32,
			RowWidth: 16, RowCount: 1, MaxElements: 8,
			Columns: []Column{{Name: "b", Offset: 0, Type: TypeB, Desc: DescFixed, FixedCount: 2}},
		}
	}

	t.Run("table exceeds data length", func(t *testing.T) {
		cfg := base()
		cfg.DataLength = 4
		if _, err := New(cfg); !errors.Is(err, ErrAddressing) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("heap outside interval", func(t *testing.T) {
		cfg := base()
		cfg.HeapStart = 33
		if _, err := New(cfg); !errors.Is(err, ErrAddressing) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("duplicate names", func(t *testing.T) {
		cfg := base()
		cfg.Columns = append(cfg.Columns, Column{Name: "b", Offset: 4, Type: TypeB, Desc: DescFixed, FixedCount: 1})
		if _, err := New(cfg); !errors.Is(err, ErrConfig) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("inline overlap", func(t *testing.T) {
		cfg := base()
		cfg.Columns = append(cfg.Columns, Column{Name: "c", Offset: 1, Type: TypeB, Desc: DescFixed, FixedCount: 2})
		if _, err := New(cfg); !errors.Is(err, ErrConfig) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("column beyond row width", func(t *testing.T) {
		cfg := base()
		cfg.Columns[0].Offset = 15
		if _, err := New(cfg); !errors.Is(err, ErrConfig) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("sentinel on byte column rejected", func(t *testing.T) {
		cfg := base()
		cfg.Columns[0].Type = TypeA
		cfg.Columns[0].NullSentinel = i64ptr(0)
		if _, err := New(cfg); !errors.Is(err, ErrConfig) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("scale on bit column rejected", func(t *testing.T) {
		cfg := base()
		cfg.Columns[0].Type = TypeX
		cfg.Columns[0].Scale = big.NewRat(1, 1)
		if _, err := New(cfg); !errors.Is(err, ErrConfig) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestRequestValidation(t *testing.T) {
	fx := buildPQFixture(t)
	table, err := New(fx.cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := table.ReadBatch([]int64{2}, []string{"pb"}); !errors.Is(err, ErrRequest) {
		t.Fatalf("row bound err = %v", err)
	}
	if _, err := table.ReadBatch([]int64{0}, []string{"nope"}); !errors.Is(err, ErrRequest) {
		t.Fatalf("column err = %v", err)
	}
}

func TestZeroRowsAndDefaultHeap(t *testing.T) {
	cfg := Config{
		Reader: newMemReader(make([]byte, 8)), DataLength: 8,
		RowWidth: 8, RowCount: 0, MaxElements: 4,
		Columns: []Column{{Name: "b", Offset: 0, Type: TypeB, Desc: DescFixed, FixedCount: 1}},
	}
	table, err := New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if table.HeapStart() != 0 {
		t.Fatalf("default heap with zero rows = %d, want 0", table.HeapStart())
	}
	batch, err := table.ReadBatch(nil, []string{"b"})
	if err != nil {
		t.Fatalf("empty batch: %v", err)
	}
	if len(batch.Arrays) != 0 {
		t.Fatalf("empty batch produced %d arrays", len(batch.Arrays))
	}

	// 默认 H=W*R（非零行）。
	cfg.RowCount = 1
	cfg.DataLength = 8
	table, err = New(cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if table.HeapStart() != 8 {
		t.Fatalf("default heap = %d, want W*R=8", table.HeapStart())
	}
}
