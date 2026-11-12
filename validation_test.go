package dataeng

import (
	"encoding/binary"
	"errors"
	"math"
	"testing"
)

func TestReadLimitChunksAndCounts(t *testing.T) {
	md := buildMeta()
	v := Variable{Name: "n", DimIDs: []int{1, 2}, Type: TypeInt, Begin: 4096}
	v.VSize = vsizeOf(md, &v)
	md.Variables = []Variable{v}

	gr := &generatedReader{fileLen: md.FileLength}
	rd, err := NewReader(md, gr)
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	sl, err := rd.ReadSlice(0, []int64{0, 0}, []int64{4, 3}, []int64{1, 1}, 8)
	if err != nil {
		t.Fatalf("ReadSlice: %v", err)
	}
	if sl.BytesRead != 48 {
		t.Fatalf("BytesRead %d want 48", sl.BytesRead)
	}
	if gr.calls < 6 {
		t.Fatalf("expected at least 6 chunked reads, got %d", gr.calls)
	}
	if _, err := rd.ReadSlice(0, []int64{0, 0}, []int64{1, 1}, []int64{1, 1}, 3); !errors.Is(err, ErrLimit) {
		t.Fatalf("want ErrLimit, got %v", err)
	}
}

func TestShortReadNoPartialSlice(t *testing.T) {
	md := buildMeta()
	v := Variable{Name: "n", DimIDs: []int{1, 2}, Type: TypeInt, Begin: 256}
	v.VSize = vsizeOf(md, &v)
	md.Variables = []Variable{v}

	rd, err := NewReader(md, shortReader{})
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	sl, err := rd.ReadSlice(0, []int64{0, 0}, []int64{2, 2}, []int64{1, 1}, 64)
	if !errors.Is(err, ErrShortRead) {
		t.Fatalf("want ErrShortRead, got %v", err)
	}
	if sl != nil {
		t.Fatalf("no slice may be delivered on short read, got %+v", sl)
	}
}

func TestFloatRawBitsAndSign(t *testing.T) {
	data := make([]byte, 4096)
	dbits := math.Float64bits(-2.5)
	binary.BigEndian.PutUint64(data[256:], dbits)
	fbits := math.Float32bits(3.14)
	binary.BigEndian.PutUint32(data[512:], fbits)
	data[1024] = 0xFF
	data[1028] = 0xFF

	md := buildMeta()
	md.Variables = []Variable{
		{Name: "d", DimIDs: nil, Type: TypeDouble, Begin: 256, VSize: 8},
		{Name: "f", DimIDs: nil, Type: TypeFloat, Begin: 512, VSize: 4},
		{Name: "b", DimIDs: nil, Type: TypeByte, Begin: 1024, VSize: 4},
		{Name: "c", DimIDs: nil, Type: TypeChar, Begin: 1028, VSize: 4},
	}
	rd, err := NewReader(md, &staticReader{data: data})
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	d, err := rd.ReadSlice(0, nil, nil, nil, 64)
	if err != nil {
		t.Fatal(err)
	}
	if d.Float64(0) != -2.5 || d.Values[0] != dbits {
		t.Fatalf("double raw bits mismatch: %#x", d.Values[0])
	}
	f, err := rd.ReadSlice(1, nil, nil, nil, 64)
	if err != nil {
		t.Fatal(err)
	}
	if f.Float32(0) != 3.14 || f.Values[0] != uint64(fbits) {
		t.Fatalf("float raw bits mismatch: %#x", f.Values[0])
	}
	b, err := rd.ReadSlice(2, nil, nil, nil, 64)
	if err != nil {
		t.Fatal(err)
	}
	if b.Int64(0) != -1 {
		t.Fatalf("signed byte: got %d", b.Int64(0))
	}
	c, err := rd.ReadSlice(3, nil, nil, nil, 64)
	if err != nil {
		t.Fatal(err)
	}
	if c.Values[0] != 255 {
		t.Fatalf("char must preserve raw byte: got %d", c.Values[0])
	}
}

func TestSliceBoundsAndArgs(t *testing.T) {
	md := buildMeta()
	v := Variable{Name: "n", DimIDs: []int{1, 2}, Type: TypeInt, Begin: 256}
	v.VSize = vsizeOf(md, &v)
	md.Variables = []Variable{v}
	rd, err := NewReader(md, blockedReader{})
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	cases := []struct {
		name             string
		start, count, st []int64
		want             error
	}{
		{"last coord out of bounds", []int64{4, 0}, []int64{1, 1}, []int64{1, 1}, ErrSlice},
		{"stride runs past end", []int64{0, 3}, []int64{1, 1}, []int64{1, 1}, ErrSlice},
		{"zero stride", []int64{0, 0}, []int64{1, 1}, []int64{1, 0}, ErrSlice},
		{"negative start", []int64{-1, 0}, []int64{1, 1}, []int64{1, 1}, ErrSlice},
		{"negative count", []int64{0, 0}, []int64{1, -1}, []int64{1, 1}, ErrSlice},
		{"wrong arity", []int64{0}, []int64{1}, []int64{1}, ErrSlice},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := rd.ReadSlice(0, tc.start, tc.count, tc.st, 64); !errors.Is(err, tc.want) {
				t.Fatalf("want %v, got %v", tc.want, err)
			}
		})
	}
	if _, err := rd.ReadSlice(9, nil, nil, nil, 64); !errors.Is(err, ErrSlice) {
		t.Fatalf("bad variable index: %v", err)
	}
}

func TestMetadataValidation(t *testing.T) {
	base := func() *Metadata {
		md := buildMeta()
		a := Variable{Name: "a", DimIDs: []int{1, 2}, Type: TypeInt, Begin: 256}
		a.VSize = vsizeOf(md, &a)
		md.Variables = []Variable{a}
		return md
	}

	t.Run("unknown dimension id", func(t *testing.T) {
		md := base()
		md.Variables[0].DimIDs = []int{99}
		_, err := NewReader(md, blockedReader{})
		if !errors.Is(err, ErrMetadata) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("record dim not first", func(t *testing.T) {
		md := base()
		md.Variables[0].DimIDs = []int{1, 0}
		_, err := NewReader(md, blockedReader{})
		if !errors.Is(err, ErrMetadata) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("two record dims", func(t *testing.T) {
		md := base()
		md.Dimensions = append(md.Dimensions, Dimension{ID: 7, Length: 0})
		_, err := NewReader(md, blockedReader{})
		if !errors.Is(err, ErrMetadata) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("unaligned begin", func(t *testing.T) {
		md := base()
		md.Variables[0].Begin = 258
		_, err := NewReader(md, blockedReader{})
		if !errors.Is(err, ErrMetadata) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("bad vsize", func(t *testing.T) {
		md := base()
		md.Variables[0].VSize++
		_, err := NewReader(md, blockedReader{})
		if !errors.Is(err, ErrLayout) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("overlap", func(t *testing.T) {
		md := base()
		b := Variable{Name: "b", DimIDs: []int{3}, Type: TypeInt, Begin: 260}
		b.VSize = vsizeOf(md, &b)
		md.Variables = append(md.Variables, b)
		_, err := NewReader(md, blockedReader{})
		if !errors.Is(err, ErrOverlap) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("normal inside record region", func(t *testing.T) {
		md := buildMeta()
		rec := Variable{Name: "r", DimIDs: []int{0, 1}, Type: TypeInt, Begin: 256}
		rec.VSize = vsizeOf(md, &rec)
		late := Variable{Name: "late", DimIDs: []int{1}, Type: TypeByte, Begin: 300}
		late.VSize = vsizeOf(md, &late)
		md.Variables = []Variable{rec, late}
		_, err := NewReader(md, blockedReader{})
		if !errors.Is(err, ErrOverlap) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("record slab gap", func(t *testing.T) {
		md := buildMeta()
		a := Variable{Name: "a", DimIDs: []int{0, 1}, Type: TypeInt, Begin: 256}
		a.VSize = vsizeOf(md, &a)
		b := Variable{Name: "b", DimIDs: []int{0, 2}, Type: TypeInt, Begin: 256 + a.VSize + 8}
		b.VSize = vsizeOf(md, &b)
		md.Variables = []Variable{a, b}
		_, err := NewReader(md, blockedReader{})
		if !errors.Is(err, ErrLayout) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("region exceeds file", func(t *testing.T) {
		md := base()
		md.FileLength = 100
		_, err := NewReader(md, blockedReader{})
		if !errors.Is(err, ErrMetadata) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("unsupported type", func(t *testing.T) {
		md := base()
		md.Variables[0].Type = 42
		_, err := NewReader(md, blockedReader{})
		if !errors.Is(err, ErrMetadata) {
			t.Fatalf("got %v", err)
		}
	})
}
