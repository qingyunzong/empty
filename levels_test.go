package dataeng

import (
	"reflect"
	"testing"
)

func i64(v int64) *int64 {
	return &v
}

func TestEncodeDefinitionLevels(t *testing.T) {
	emptyOuter := make([][]*int64, 0)
	emptyInner := make([]*int64, 0)

	tests := []struct {
		name string
		row  Row
		want []Token
	}{
		{"outer null", Row{}, []Token{{R: 0, D: 0}}},
		{"outer empty", Row{Outer: &emptyOuter}, []Token{{R: 0, D: 1}}},
		{"element null", Row{Outer: &[][]*int64{nil}}, []Token{{R: 0, D: 2}}},
		{"inner empty", Row{Outer: &[][]*int64{emptyInner}}, []Token{{R: 0, D: 3}}},
		{"leaf null", Row{Outer: &[][]*int64{{nil}}}, []Token{{R: 0, D: 4}}},
		{"leaf value", Row{Outer: &[][]*int64{{i64(7)}}}, []Token{{R: 0, D: 5, Value: i64(7)}}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := EncodeRows([]Row{tt.row})
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("EncodeRows = %+v, want %+v", got, tt.want)
			}
		})
	}
}

func TestEncodeComplexRow(t *testing.T) {
	row := Row{Outer: &[][]*int64{
		{i64(1), nil, i64(3)},
		nil,
		{},
		{nil, i64(9)},
	}}

	want := []Token{
		{R: 0, D: 5, Value: i64(1)},
		{R: 2, D: 4},
		{R: 2, D: 5, Value: i64(3)},
		{R: 1, D: 2},
		{R: 1, D: 3},
		{R: 1, D: 4},
		{R: 2, D: 5, Value: i64(9)},
	}

	got := EncodeRows([]Row{row})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("EncodeRows = %+v\nwant         %+v", got, want)
	}

	decoded, err := DecodeAll(got, 1)
	if err != nil {
		t.Fatalf("DecodeAll: %v", err)
	}
	if len(decoded) != 1 || !reflect.DeepEqual(decoded[0], row) {
		t.Fatalf("round trip = %+v, want %+v", decoded, row)
	}
}

func TestEncodeTwoEmptyRows(t *testing.T) {
	emptyOuter := make([][]*int64, 0)
	rows := []Row{{Outer: &emptyOuter}, {Outer: &emptyOuter}}
	want := []Token{{R: 0, D: 1}, {R: 0, D: 1}}

	if got := EncodeRows(rows); !reflect.DeepEqual(got, want) {
		t.Fatalf("EncodeRows = %+v, want %+v", got, want)
	}
}

func TestLeafTokenPositionsPreserved(t *testing.T) {
	rows := []Row{
		{Outer: &[][]*int64{{i64(10)}, {i64(11), i64(12)}}},
		{},
		{Outer: &[][]*int64{nil, {i64(13), nil, i64(14)}}},
	}

	tokens := EncodeRows(rows)
	var streamValues, leafValues []int64
	for _, tok := range tokens {
		if tok.D == 5 {
			streamValues = append(streamValues, *tok.Value)
		}
	}

	decoded, err := DecodeAll(tokens, len(rows))
	if err != nil {
		t.Fatalf("DecodeAll: %v", err)
	}
	for _, row := range decoded {
		if row.Outer == nil {
			continue
		}
		for _, inner := range *row.Outer {
			for _, leaf := range inner {
				if leaf != nil {
					leafValues = append(leafValues, *leaf)
				}
			}
		}
	}

	if !reflect.DeepEqual(leafValues, streamValues) {
		t.Fatalf("leaf order %v, token order %v", leafValues, streamValues)
	}
	if !reflect.DeepEqual(leafValues, []int64{10, 11, 12, 13, 14}) {
		t.Fatalf("unexpected leaf sequence: %v", leafValues)
	}
}

func TestNullAndEmptyAreDistinct(t *testing.T) {
	emptyOuter := make([][]*int64, 0)
	emptyInner := make([]*int64, 0)

	nullOuter := Row{}
	emptyOuterRow := Row{Outer: &emptyOuter}
	if reflect.DeepEqual(nullOuter, emptyOuterRow) {
		t.Fatal("null outer list must differ from empty outer list")
	}

	rows := []Row{
		{},
		{Outer: &emptyOuter},
		{Outer: &[][]*int64{nil}},
		{Outer: &[][]*int64{emptyInner}},
		{Outer: &[][]*int64{{nil}}},
	}

	tokens := EncodeRows(rows)
	wantD := []int{0, 1, 2, 3, 4}
	for i, tok := range tokens {
		if tok.D != wantD[i] {
			t.Fatalf("token %d: d=%d, want %d", i, tok.D, wantD[i])
		}
	}

	decoded, err := DecodeAll(tokens, len(rows))
	if err != nil {
		t.Fatalf("DecodeAll: %v", err)
	}
	if !reflect.DeepEqual(decoded, rows) {
		t.Fatalf("round trip collapsed null and empty:\n got %+v\nwant %+v", decoded, rows)
	}
}
