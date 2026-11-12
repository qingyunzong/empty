package dataeng

import "testing"

func typeName(typ CDFType) string {
	switch typ {
	case TypeByte:
		return "byte"
	case TypeChar:
		return "char"
	case TypeShort:
		return "short"
	case TypeInt:
		return "int"
	case TypeFloat:
		return "float"
	case TypeDouble:
		return "double"
	default:
		return "unknown"
	}
}

func TestSingleRecordVariableUnpadded(t *testing.T) {
	for _, typ := range []CDFType{TypeByte, TypeChar, TypeShort, TypeInt, TypeFloat, TypeDouble} {
		t.Run(typeName(typ), func(t *testing.T) {
			md := buildMeta()
			v := Variable{Name: "r", DimIDs: []int{0, 1}, Type: typ, Begin: 256}
			v.VSize = vsizeOf(md, &v)
			md.Variables = []Variable{v}

			gr := &generatedReader{fileLen: md.FileLength}
			rd, err := NewReader(md, gr)
			if err != nil {
				t.Fatalf("NewReader: %v", err)
			}
			if rd.recStride != rd.vars[0].dataSize {
				t.Fatalf("recStride %d want unpadded %d", rd.recStride, rd.vars[0].dataSize)
			}
			if rd.vars[0].vsize != v.VSize {
				t.Fatalf("vsize altered: got %d want %d", rd.vars[0].vsize, v.VSize)
			}

			checkSlice(t, rd, md, 0, []int64{0, 0}, []int64{md.NumRecords, 4}, []int64{1, 1}, 64)
			checkSlice(t, rd, md, 0, []int64{1, 1}, []int64{3, 2}, []int64{2, 2}, 16)
			checkSlice(t, rd, md, 0, []int64{5, 3}, []int64{1, 1}, []int64{1, 1}, 4096)
		})
	}
}

func TestTwoRecordVariablesInterleaved(t *testing.T) {
	md := buildMeta()
	a := Variable{Name: "a", DimIDs: []int{0, 1}, Type: TypeShort, Begin: 512}
	a.VSize = vsizeOf(md, &a)
	b := Variable{Name: "b", DimIDs: []int{0, 1, 2}, Type: TypeFloat, Begin: 512 + a.VSize}
	b.VSize = vsizeOf(md, &b)
	md.Variables = []Variable{a, b}

	gr := &generatedReader{fileLen: md.FileLength}
	rd, err := NewReader(md, gr)
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	if want := a.VSize + b.VSize; rd.recStride != want {
		t.Fatalf("recStride %d want padded %d", rd.recStride, want)
	}

	checkSlice(t, rd, md, 0, []int64{0, 0}, []int64{6, 4}, []int64{1, 1}, 16)
	checkSlice(t, rd, md, 1, []int64{0, 0, 0}, []int64{6, 4, 3}, []int64{1, 1, 1}, 40)
	checkSlice(t, rd, md, 1, []int64{2, 1, 0}, []int64{2, 3, 2}, []int64{2, 1, 2}, 12)
}

func TestScalarVariable(t *testing.T) {
	md := buildMeta()
	scalar := Variable{Name: "s", DimIDs: nil, Type: TypeDouble, Begin: 128}
	scalar.VSize = vsizeOf(md, &scalar)
	normal := Variable{Name: "n", DimIDs: []int{1, 2}, Type: TypeInt, Begin: 256}
	normal.VSize = vsizeOf(md, &normal)
	md.Variables = []Variable{scalar, normal}

	gr := &generatedReader{fileLen: md.FileLength}
	rd, err := NewReader(md, gr)
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	sl := checkSlice(t, rd, md, 0, nil, nil, nil, 16)
	if len(sl.Values) != 1 || sl.Offsets[0] != 128 {
		t.Fatalf("scalar must have exactly one value: %+v", sl)
	}
	checkSlice(t, rd, md, 1, []int64{0, 0}, []int64{4, 3}, []int64{1, 1}, 64)
	checkSlice(t, rd, md, 1, []int64{3, 2}, []int64{1, 1}, []int64{1, 1}, 8)
}

func TestEmptySliceDoesNotRead(t *testing.T) {
	md := buildMeta()
	a := Variable{Name: "a", DimIDs: []int{0, 1}, Type: TypeShort, Begin: 64}
	a.VSize = vsizeOf(md, &a)
	b := Variable{Name: "b", DimIDs: []int{1, 2}, Type: TypeChar, Begin: 256}
	b.VSize = vsizeOf(md, &b)
	md.Variables = []Variable{a, b}
	// b must sit before the record region beginning at 64: move it to 0.
	md.Variables[1].Begin = 0

	rd, err := NewReader(md, blockedReader{})
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	if _, err := rd.ReadSlice(0, []int64{0, 0}, []int64{0, 4}, []int64{1, 1}, 64); err != nil {
		t.Fatalf("empty record slice: %v", err)
	}
	if _, err := rd.ReadSlice(1, []int64{0, 0}, []int64{4, 0}, []int64{1, 1}, 64); err != nil {
		t.Fatalf("empty normal slice: %v", err)
	}
}

func TestLargeOffsetAndRecordStride(t *testing.T) {
	md := &Metadata{
		FileLength: 1 << 30,
		NumRecords: 4,
		Dimensions: []Dimension{
			{ID: 0, Length: 0},
			{ID: 1, Length: 7},
		},
	}
	rec := Variable{Name: "big", DimIDs: []int{0, 1}, Type: TypeDouble, Begin: 1 << 28}
	rec.VSize = vsizeOf(md, &rec)
	md.Variables = []Variable{rec}

	gr := &generatedReader{fileLen: md.FileLength}
	rd, err := NewReader(md, gr)
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	if rd.recStride != 56 {
		t.Fatalf("recStride %d want 56", rd.recStride)
	}
	checkSlice(t, rd, md, 0, []int64{0, 0}, []int64{4, 7}, []int64{1, 1}, 32)
	checkSlice(t, rd, md, 0, []int64{3, 6}, []int64{1, 1}, []int64{1, 1}, 16)
	checkSlice(t, rd, md, 0, []int64{1, 1}, []int64{2, 2}, []int64{2, 3}, 24)

	md2 := buildMeta()
	normal := Variable{Name: "n", DimIDs: []int{3, 2}, Type: TypeInt, Begin: 1 << 29}
	normal.VSize = vsizeOf(md2, &normal)
	md2.FileLength = 1 << 30
	md2.Variables = []Variable{normal}
	rd2, err := NewReader(md2, &generatedReader{fileLen: md2.FileLength})
	if err != nil {
		t.Fatalf("NewReader normal: %v", err)
	}
	checkSlice(t, rd2, md2, 0, []int64{0, 0}, []int64{5, 3}, []int64{1, 1}, 32)
}
