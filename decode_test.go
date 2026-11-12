package dataeng_test

import (
	"errors"
	"math"
	"reflect"
	"testing"

	de "example.org/dataeng/q0331"
)

// The helpers below are an independent encoder for the test vectors. They do
// not call the decoder under test.

func uleb(v uint64) []byte {
	var out []byte
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			b |= 0x80
		}
		out = append(out, b)
		if v == 0 {
			return out
		}
	}
}

func zz16(n int16) uint64 {
	return uint64(uint16(n)<<1 ^ uint16(n>>15))
}

func zz32(n int32) uint64 {
	return uint64(uint32(n)<<1 ^ uint32(n>>31))
}

func zz64(n int64) uint64 {
	return uint64(n)<<1 ^ uint64(n>>63)
}

func fieldDelta(delta byte, t de.Type) []byte {
	return []byte{delta<<4 | byte(t)}
}

func fieldAbs(t de.Type, id int32) []byte {
	out := []byte{byte(t)}
	return append(out, uleb(zz32(id))...)
}

func listHeader(count int, elem de.Type) []byte {
	if count < 15 {
		return []byte{byte(count<<4 | int(elem))}
	}
	out := []byte{0xf0 | byte(elem)}
	return append(out, uleb(zz32(int32(count)))...)
}

func mapHeader(count int, key, value de.Type) []byte {
	out := uleb(zz32(int32(count)))
	if count > 0 {
		out = append(out, byte(key)<<4|byte(value))
	}
	return out
}

func int32Value(n int32) []byte {
	return uleb(zz32(n))
}

func structEnd() []byte {
	return []byte{0x00}
}

func TestBooleanFieldsReadNoValueByte(t *testing.T) {
	schema := de.Struct(
		de.FieldOf(1, de.TypeTrue),
		de.FieldOf(2, de.TypeFalse),
		de.FieldOf(3, de.TypeByte),
		de.FieldOf(4, de.TypeInt16),
	)

	wire := []byte{}
	wire = append(wire, fieldDelta(1, de.TypeTrue)...)
	wire = append(wire, fieldDelta(1, de.TypeFalse)...)
	wire = append(wire, fieldDelta(1, de.TypeByte)...)
	wire = append(wire, 0x7f) // TypeByte's one byte
	wire = append(wire, fieldDelta(1, de.TypeInt16)...)
	wire = append(wire, uleb(zz16(-2))...)
	wire = append(wire, structEnd()...)

	got, err := de.Decode(wire, schema)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	want := &de.Value{Type: de.TypeStruct, Fields: []de.FieldValue{
		{ID: 1, Value: de.Value{Type: de.TypeTrue, Bool: true}},
		{ID: 2, Value: de.Value{Type: de.TypeFalse, Bool: false}},
		{ID: 3, Value: de.Value{Type: de.TypeByte, Byte: 0x7f, Int: 0x7f}},
		{ID: 4, Value: de.Value{Type: de.TypeInt16, Int: -2}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("value mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestFieldIdentifierDifferenceGreaterThanFifteen(t *testing.T) {
	// Identifier 100 cannot be represented as a first delta, and the jump
	// from 100 to 120 is also larger than the four-bit delta field.
	schema := de.Struct(
		de.FieldOf(100, de.TypeInt32),
		de.FieldOf(120, de.TypeInt32),
	)

	wire := fieldAbs(de.TypeInt32, 100)
	wire = append(wire, int32Value(-5)...)
	wire = append(wire, fieldAbs(de.TypeInt32, 120)...)
	wire = append(wire, int32Value(1000)...)
	wire = append(wire, structEnd()...)

	got, err := de.Decode(wire, schema)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	want := &de.Value{Type: de.TypeStruct, Fields: []de.FieldValue{
		{ID: 100, Value: de.Value{Type: de.TypeInt32, Int: -5}},
		{ID: 120, Value: de.Value{Type: de.TypeInt32, Int: 1000}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("value mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestListLengthsZeroThroughFourteen(t *testing.T) {
	schema := de.List(de.Scalar(de.TypeInt32))

	for count := 0; count <= 14; count++ {
		wire := listHeader(count, de.TypeInt32)
		want := &de.Value{Type: de.TypeList, Elements: make([]de.Value, 0, count)}
		for i := 0; i < count; i++ {
			wire = append(wire, int32Value(int32(i*3-7))...)
			want.Elements = append(want.Elements, de.Value{
				Type: de.TypeInt32,
				Int:  int64(i*3 - 7),
			})
		}

		got, err := de.Decode(wire, schema)
		if err != nil {
			t.Fatalf("count %d: Decode: %v", count, err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("count %d: value mismatch\n got: %#v\nwant: %#v", count, got, want)
		}
	}
}

func TestExplicitListLength(t *testing.T) {
	schema := de.List(de.Scalar(de.TypeInt32))
	wire := listHeader(20, de.TypeInt32)
	want := &de.Value{Type: de.TypeList, Elements: make([]de.Value, 0, 20)}
	for i := 0; i < 20; i++ {
		wire = append(wire, int32Value(int32(i))...)
		want.Elements = append(want.Elements, de.Value{Type: de.TypeInt32, Int: int64(i)})
	}
	got, err := de.Decode(wire, schema)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("value mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestEmptyMapHasNoTypeByte(t *testing.T) {
	schema := de.Struct(de.Field(1, de.Map(
		de.Scalar(de.TypeInt32),
		de.Scalar(de.TypeBytes),
	)))

	wire := fieldDelta(1, de.TypeMap)
	wire = append(wire, mapHeader(0, 0, 0)...)
	wire = append(wire, structEnd()...)

	got, err := de.Decode(wire, schema)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	want := &de.Value{Type: de.TypeStruct, Fields: []de.FieldValue{
		{ID: 1, Value: de.Value{Type: de.TypeMap, Entries: []de.MapEntry{}}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("value mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestMapPairs(t *testing.T) {
	schema := de.Map(de.Scalar(de.TypeInt32), de.Scalar(de.TypeBytes))
	wire := mapHeader(2, de.TypeInt32, de.TypeBytes)
	wire = append(wire, int32Value(-1)...)
	wire = append(wire, uleb(zz32(3))...)
	wire = append(wire, []byte{'a', 'b', 'c'}...)
	wire = append(wire, int32Value(9)...)
	wire = append(wire, uleb(zz32(0))...)

	got, err := de.Decode(wire, schema)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	want := &de.Value{Type: de.TypeMap, Entries: []de.MapEntry{
		{
			Key:   de.Value{Type: de.TypeInt32, Int: -1},
			Value: de.Value{Type: de.TypeBytes, Bytes: []byte{'a', 'b', 'c'}},
		},
		{
			Key:   de.Value{Type: de.TypeInt32, Int: 9},
			Value: de.Value{Type: de.TypeBytes, Bytes: []byte{}},
		},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("value mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestFloat64LittleEndianAndSpecialValues(t *testing.T) {
	schema := de.Struct(de.FieldOf(1, de.TypeFloat64))
	cases := []struct {
		name string
		bits uint64
	}{
		{"finite", 0x3ff8000000000000},
		{"quiet-nan", 0x7ff8000000000001},
		{"positive-infinity", 0x7ff0000000000000},
		{"negative-infinity", 0xfff0000000000000},
		{"negative-zero", 0x8000000000000000},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			wire := fieldDelta(1, de.TypeFloat64)
			for i := 0; i < 8; i++ {
				wire = append(wire, byte(tc.bits>>uint(8*i)))
			}
			wire = append(wire, structEnd()...)

			got, err := de.Decode(wire, schema)
			if err != nil {
				t.Fatalf("Decode: %v", err)
			}
			field, ok := got.LookupField(1)
			if !ok {
				t.Fatalf("field 1 missing")
			}
			if field.FloatBits != tc.bits {
				t.Fatalf("FloatBits = %#x, want %#x", field.FloatBits, tc.bits)
			}
			if math.Float64bits(field.Float) != tc.bits {
				t.Fatalf("float bits = %#x, want %#x", math.Float64bits(field.Float), tc.bits)
			}
			if tc.bits == 0x8000000000000000 && !math.Signbit(field.Float) {
				t.Fatalf("negative zero lost its sign")
			}
		})
	}
}

func TestContainerBooleanTypesAreRejected(t *testing.T) {
	t.Run("schema declaration", func(t *testing.T) {
		_, err := de.Decode([]byte{0x00}, de.List(de.Scalar(de.TypeTrue)))
		if !errors.Is(err, de.ErrSchema) {
			t.Fatalf("err = %v, want ErrSchema", err)
		}
	})

	t.Run("list element nibble", func(t *testing.T) {
		// Empty list whose element type nibble is boolean true.
		wire := []byte{0x00<<4 | byte(de.TypeTrue)}
		_, err := de.Decode(wire, de.List(de.Scalar(de.TypeInt32)))
		if !errors.Is(err, de.ErrCorrupt) {
			t.Fatalf("err = %v, want ErrCorrupt", err)
		}
	})

	t.Run("map key declaration", func(t *testing.T) {
		_, err := de.Decode([]byte{0x00}, de.Map(
			de.Scalar(de.TypeFalse),
			de.Scalar(de.TypeInt32),
		))
		if !errors.Is(err, de.ErrSchema) {
			t.Fatalf("err = %v, want ErrSchema", err)
		}
	})

	t.Run("map type nibble", func(t *testing.T) {
		wire := uleb(zz32(1))
		wire = append(wire, byte(de.TypeTrue)<<4|byte(de.TypeInt32))
		wire = append(wire, uleb(zz32(7))...)
		wire = append(wire, []byte{0x00}...)
		_, err := de.Decode(wire, de.Map(de.Scalar(de.TypeInt32), de.Scalar(de.TypeInt32)))
		if !errors.Is(err, de.ErrCorrupt) {
			t.Fatalf("err = %v, want ErrCorrupt", err)
		}
	})
}

func TestVarintRejections(t *testing.T) {
	t.Run("32-bit count too many bytes", func(t *testing.T) {
		wire := append(listHeader(15, de.TypeInt32), []byte{0x80, 0x80, 0x80, 0x80, 0x80}...)
		_, err := de.Decode(wire, de.List(de.Scalar(de.TypeInt32)))
		if !errors.Is(err, de.ErrVarintOverflow) {
			t.Fatalf("err = %v, want ErrVarintOverflow", err)
		}
	})

	t.Run("32-bit count reserved final bits", func(t *testing.T) {
		wire := append(listHeader(15, de.TypeInt32), []byte{0x80, 0x80, 0x80, 0x80, 0x10}...)
		_, err := de.Decode(wire, de.List(de.Scalar(de.TypeInt32)))
		if !errors.Is(err, de.ErrVarintOverflow) {
			t.Fatalf("err = %v, want ErrVarintOverflow", err)
		}
	})

	t.Run("32-bit count non-minimal", func(t *testing.T) {
		wire := append(listHeader(15, de.TypeInt32), []byte{0x80, 0x00}...)
		_, err := de.Decode(wire, de.List(de.Scalar(de.TypeInt32)))
		if !errors.Is(err, de.ErrNonMinimalVarint) {
			t.Fatalf("err = %v, want ErrNonMinimalVarint", err)
		}
	})

	t.Run("16-bit scalar too many bytes", func(t *testing.T) {
		wire := fieldDelta(1, de.TypeInt16)
		wire = append(wire, 0x80, 0x80, 0x80)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, de.Struct(de.FieldOf(1, de.TypeInt16)))
		if !errors.Is(err, de.ErrVarintOverflow) {
			t.Fatalf("err = %v, want ErrVarintOverflow", err)
		}
	})

	t.Run("16-bit scalar reserved final bits", func(t *testing.T) {
		wire := fieldDelta(1, de.TypeInt16)
		wire = append(wire, 0x80, 0x80, 0x04)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, de.Struct(de.FieldOf(1, de.TypeInt16)))
		if !errors.Is(err, de.ErrVarintOverflow) {
			t.Fatalf("err = %v, want ErrVarintOverflow", err)
		}
	})

	t.Run("16-bit scalar non-minimal", func(t *testing.T) {
		wire := fieldDelta(1, de.TypeInt16)
		wire = append(wire, 0x80, 0x00)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, de.Struct(de.FieldOf(1, de.TypeInt16)))
		if !errors.Is(err, de.ErrNonMinimalVarint) {
			t.Fatalf("err = %v, want ErrNonMinimalVarint", err)
		}
	})

	t.Run("64-bit scalar tenth byte reserved", func(t *testing.T) {
		wire := fieldDelta(1, de.TypeInt64)
		wire = append(wire, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, de.Struct(de.FieldOf(1, de.TypeInt64)))
		if !errors.Is(err, de.ErrVarintOverflow) {
			t.Fatalf("err = %v, want ErrVarintOverflow", err)
		}
	})

	t.Run("64-bit scalar non-minimal", func(t *testing.T) {
		wire := fieldDelta(1, de.TypeInt64)
		wire = append(wire, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, de.Struct(de.FieldOf(1, de.TypeInt64)))
		if !errors.Is(err, de.ErrNonMinimalVarint) {
			t.Fatalf("err = %v, want ErrNonMinimalVarint", err)
		}
	})

	t.Run("byte length non-minimal", func(t *testing.T) {
		wire := fieldDelta(1, de.TypeBytes)
		wire = append(wire, 0x80, 0x00)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, de.Struct(de.FieldOf(1, de.TypeBytes)))
		if !errors.Is(err, de.ErrNonMinimalVarint) {
			t.Fatalf("err = %v, want ErrNonMinimalVarint", err)
		}
	})

	t.Run("absolute field id non-minimal", func(t *testing.T) {
		wire := []byte{byte(de.TypeInt32), 0x80, 0x00}
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, de.Struct(de.FieldOf(1, de.TypeInt32)))
		if !errors.Is(err, de.ErrNonMinimalVarint) {
			t.Fatalf("err = %v, want ErrNonMinimalVarint", err)
		}
	})
}

func TestChunkingAndIncompleteFinish(t *testing.T) {
	schema := de.Struct(
		de.FieldOf(1, de.TypeInt32),
		de.FieldOf(2, de.TypeBytes),
		de.FieldOf(3, de.TypeFloat64),
	)

	wire := fieldDelta(1, de.TypeInt32)
	wire = append(wire, int32Value(-12345)...)
	wire = append(wire, fieldDelta(1, de.TypeBytes)...)
	wire = append(wire, uleb(zz32(5))...)
	wire = append(wire, []byte("chunk")...)
	wire = append(wire, fieldDelta(1, de.TypeFloat64)...)
	wire = append(wire, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f)
	wire = append(wire, structEnd()...)

	// One-byte chunks exercise stopping in the middle of varints and all
	// value kinds.
	d := de.NewDecoder(schema)
	for i, b := range wire {
		if err := d.Feed([]byte{b}); err != nil {
			t.Fatalf("byte %d: Feed: %v", i, err)
		}
	}
	got, err := d.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	want := &de.Value{Type: de.TypeStruct, Fields: []de.FieldValue{
		{ID: 1, Value: de.Value{Type: de.TypeInt32, Int: -12345}},
		{ID: 2, Value: de.Value{Type: de.TypeBytes, Bytes: []byte("chunk")}},
		{ID: 3, Value: de.Value{Type: de.TypeFloat64, Float: 1.5, FloatBits: 0x3ff8000000000000}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("value mismatch\n got: %#v\nwant: %#v", got, want)
	}

	d2 := de.NewDecoder(schema)
	if err := d2.Feed(wire[:len(wire)-1]); err != nil {
		t.Fatalf("Feed: %v", err)
	}
	value, err := d2.Finish()
	if !errors.Is(err, de.ErrIncomplete) {
		t.Fatalf("Finish err = %v, want ErrIncomplete", err)
	}
	if value != nil {
		t.Fatalf("Finish delivered a partial value: %#v", value)
	}
}

func TestTrailingBytesAndStickyFailure(t *testing.T) {
	schema := de.Struct(de.FieldOf(1, de.TypeInt32))
	wire := fieldDelta(1, de.TypeInt32)
	wire = append(wire, int32Value(3)...)
	wire = append(wire, structEnd()...)

	d := de.NewDecoder(schema)
	if err := d.Feed(append(wire, 0xaa)); !errors.Is(err, de.ErrTrailingBytes) {
		t.Fatalf("Feed err = %v, want ErrTrailingBytes", err)
	}
	if d.Value() != nil {
		t.Fatalf("decoder exposed a value after failure")
	}
	if err := d.Feed([]byte{0x01}); !errors.Is(err, de.ErrTrailingBytes) {
		t.Fatalf("second Feed err = %v, want sticky ErrTrailingBytes", err)
	}
	if _, err := d.Finish(); !errors.Is(err, de.ErrTrailingBytes) {
		t.Fatalf("Finish err = %v, want sticky ErrTrailingBytes", err)
	}

	// Bytes that arrive after a successful completion are also trailing
	// bytes, not part of a second value.
	d2 := de.NewDecoder(schema)
	if err := d2.Feed(wire); err != nil {
		t.Fatalf("Feed: %v", err)
	}
	if !d2.Complete() {
		t.Fatalf("decoder did not complete on a whole value")
	}
	if err := d2.Feed([]byte{0x00}); !errors.Is(err, de.ErrTrailingBytes) {
		t.Fatalf("Feed after completion err = %v, want ErrTrailingBytes", err)
	}
	if d2.Value() != nil {
		t.Fatalf("decoder exposed a value after trailing-byte failure")
	}
}

func TestBudgetChecks(t *testing.T) {
	t.Run("depth", func(t *testing.T) {
		schema := de.List(de.List(de.Scalar(de.TypeInt32)))
		wire := listHeader(1, de.TypeList)
		wire = append(wire, listHeader(1, de.TypeInt32)...)
		wire = append(wire, int32Value(7)...)
		_, err := de.Decode(wire, schema, de.Limits{MaxDepth: 1})
		if !errors.Is(err, de.ErrBudget) {
			t.Fatalf("err = %v, want ErrBudget", err)
		}
	})

	t.Run("element count", func(t *testing.T) {
		schema := de.List(de.Scalar(de.TypeInt32))
		wire := listHeader(3, de.TypeInt32)
		_, err := de.Decode(wire, schema, de.Limits{MaxElements: 2})
		if !errors.Is(err, de.ErrBudget) {
			t.Fatalf("err = %v, want ErrBudget", err)
		}
	})

	t.Run("huge explicit element count", func(t *testing.T) {
		schema := de.List(de.Scalar(de.TypeInt32))
		wire := listHeader(15, de.TypeInt32)
		wire = append(wire, uleb(zz32(math.MaxInt32))...)
		_, err := de.Decode(wire, schema, de.Limits{MaxElements: 10})
		if !errors.Is(err, de.ErrBudget) {
			t.Fatalf("err = %v, want ErrBudget", err)
		}
	})

	t.Run("byte length", func(t *testing.T) {
		schema := de.Struct(de.FieldOf(1, de.TypeBytes))
		wire := fieldDelta(1, de.TypeBytes)
		wire = append(wire, uleb(zz32(100))...)
		_, err := de.Decode(wire, schema, de.Limits{MaxBytes: 10})
		if !errors.Is(err, de.ErrBudget) {
			t.Fatalf("err = %v, want ErrBudget", err)
		}
	})
}

func TestSchemaMatchingFailures(t *testing.T) {
	t.Run("missing field", func(t *testing.T) {
		schema := de.Struct(de.FieldOf(1, de.TypeInt32), de.FieldOf(2, de.TypeInt32))
		wire := fieldDelta(1, de.TypeInt32)
		wire = append(wire, int32Value(1)...)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, schema)
		if !errors.Is(err, de.ErrSchemaMismatch) {
			t.Fatalf("err = %v, want ErrSchemaMismatch", err)
		}
	})

	t.Run("unexpected field", func(t *testing.T) {
		schema := de.Struct(de.FieldOf(1, de.TypeInt32))
		wire := fieldDelta(1, de.TypeInt32)
		wire = append(wire, int32Value(1)...)
		wire = append(wire, fieldDelta(1, de.TypeInt32)...)
		wire = append(wire, int32Value(2)...)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, schema)
		if !errors.Is(err, de.ErrSchemaMismatch) {
			t.Fatalf("err = %v, want ErrSchemaMismatch", err)
		}
	})

	t.Run("type mismatch", func(t *testing.T) {
		schema := de.Struct(de.FieldOf(1, de.TypeInt32))
		wire := fieldDelta(1, de.TypeFloat64)
		wire = append(wire, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf8, 0x3f)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, schema)
		if !errors.Is(err, de.ErrSchemaMismatch) {
			t.Fatalf("err = %v, want ErrSchemaMismatch", err)
		}
	})

	t.Run("nonzero high nibble on end", func(t *testing.T) {
		wire := []byte{0x10}
		_, err := de.Decode(wire, de.Struct())
		if !errors.Is(err, de.ErrCorrupt) {
			t.Fatalf("err = %v, want ErrCorrupt", err)
		}
	})

	t.Run("non-positive absolute identifier", func(t *testing.T) {
		wire := fieldAbs(de.TypeInt32, 0)
		wire = append(wire, int32Value(1)...)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, de.Struct(de.FieldOf(1, de.TypeInt32)))
		if !errors.Is(err, de.ErrFieldID) {
			t.Fatalf("err = %v, want ErrFieldID", err)
		}
	})

	t.Run("absolute identifier not increasing", func(t *testing.T) {
		wire := fieldAbs(de.TypeInt32, 1)
		wire = append(wire, int32Value(1)...)
		wire = append(wire, fieldAbs(de.TypeInt32, 1)...)
		wire = append(wire, int32Value(2)...)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, de.Struct(
			de.FieldOf(1, de.TypeInt32),
			de.FieldOf(2, de.TypeInt32),
		))
		if !errors.Is(err, de.ErrFieldID) {
			t.Fatalf("err = %v, want ErrFieldID", err)
		}
	})
}

func TestNestedContainersAndRawBytes(t *testing.T) {
	inner := de.Struct(
		de.FieldOf(1, de.TypeTrue),
		de.FieldOf(2, de.TypeBytes),
	)
	schema := de.Struct(
		de.Field(1, de.List(inner)),
		de.Field(2, de.Set(de.Scalar(de.TypeInt32))),
		de.FieldOf(3, de.TypeBytes),
	)

	// One list element, an empty set, and one raw byte string.
	wire := fieldDelta(1, de.TypeList)
	wire = append(wire, listHeader(1, de.TypeStruct)...)
	wire = append(wire, fieldDelta(1, de.TypeTrue)...)
	wire = append(wire, fieldDelta(1, de.TypeBytes)...)
	wire = append(wire, uleb(zz32(2))...)
	wire = append(wire, []byte{0xde, 0xad}...)
	wire = append(wire, structEnd()...)

	wire = append(wire, fieldDelta(1, de.TypeSet)...)
	wire = append(wire, listHeader(0, de.TypeInt32)...)

	wire = append(wire, fieldDelta(1, de.TypeBytes)...)
	wire = append(wire, uleb(zz32(5))...)
	wire = append(wire, []byte("hello")...)
	wire = append(wire, structEnd()...)

	got, err := de.Decode(wire, schema)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	want := &de.Value{Type: de.TypeStruct, Fields: []de.FieldValue{
		{
			ID: 1,
			Value: de.Value{Type: de.TypeList, Elements: []de.Value{
				{
					Type: de.TypeStruct,
					Fields: []de.FieldValue{
						{ID: 1, Value: de.Value{Type: de.TypeTrue, Bool: true}},
						{ID: 2, Value: de.Value{Type: de.TypeBytes, Bytes: []byte{0xde, 0xad}}},
					},
				},
			}},
		},
		{
			ID:    2,
			Value: de.Value{Type: de.TypeSet, Elements: []de.Value{}},
		},
		{
			ID:    3,
			Value: de.Value{Type: de.TypeBytes, Bytes: []byte("hello")},
		},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("value mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestSignedIntegerWidths(t *testing.T) {
	schema := de.Struct(
		de.FieldOf(1, de.TypeInt16),
		de.FieldOf(2, de.TypeInt32),
		de.FieldOf(3, de.TypeInt64),
	)
	wire := fieldDelta(1, de.TypeInt16)
	wire = append(wire, uleb(zz16(-32768))...)
	wire = append(wire, fieldDelta(1, de.TypeInt32)...)
	wire = append(wire, uleb(zz32(-2147483648))...)
	wire = append(wire, fieldDelta(1, de.TypeInt64)...)
	wire = append(wire, uleb(zz64(-9223372036854775808))...)
	wire = append(wire, structEnd()...)

	got, err := de.Decode(wire, schema)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	want := &de.Value{Type: de.TypeStruct, Fields: []de.FieldValue{
		{ID: 1, Value: de.Value{Type: de.TypeInt16, Int: -32768}},
		{ID: 2, Value: de.Value{Type: de.TypeInt32, Int: -2147483648}},
		{ID: 3, Value: de.Value{Type: de.TypeInt64, Int: -9223372036854775808}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("value mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestSchemaValidationErrors(t *testing.T) {
	t.Run("nil root", func(t *testing.T) {
		_, err := de.Decode(nil, nil)
		if !errors.Is(err, de.ErrSchema) {
			t.Fatalf("err = %v, want ErrSchema", err)
		}
	})

	t.Run("duplicate field id", func(t *testing.T) {
		schema := de.Struct(de.FieldOf(1, de.TypeInt32), de.FieldOf(1, de.TypeInt16))
		_, err := de.Decode(nil, schema)
		if !errors.Is(err, de.ErrSchema) {
			t.Fatalf("err = %v, want ErrSchema", err)
		}
	})

	t.Run("container without element", func(t *testing.T) {
		_, err := de.Decode(nil, &de.Schema{Type: de.TypeList})
		if !errors.Is(err, de.ErrSchema) {
			t.Fatalf("err = %v, want ErrSchema", err)
		}
	})

	t.Run("field type disagrees with child schema", func(t *testing.T) {
		schema := de.Struct(de.FieldSchema{
			ID:     1,
			Type:   de.TypeInt16,
			Schema: de.Scalar(de.TypeInt32),
		})
		_, err := de.Decode(nil, schema)
		if !errors.Is(err, de.ErrSchema) {
			t.Fatalf("err = %v, want ErrSchema", err)
		}
	})

	t.Run("container field without child schema", func(t *testing.T) {
		schema := de.Struct(de.FieldOf(1, de.TypeList))
		_, err := de.Decode(nil, schema)
		if !errors.Is(err, de.ErrSchema) {
			t.Fatalf("err = %v, want ErrSchema", err)
		}
	})

	t.Run("map missing value schema", func(t *testing.T) {
		schema := &de.Schema{Type: de.TypeMap, Key: de.Scalar(de.TypeInt32)}
		_, err := de.Decode(nil, schema)
		if !errors.Is(err, de.ErrSchema) {
			t.Fatalf("err = %v, want ErrSchema", err)
		}
	})
}

func TestDecoderWriterAndInterfaceHelpers(t *testing.T) {
	schema := de.Struct(
		de.Field(1, de.Map(de.Scalar(de.TypeInt32), de.Scalar(de.TypeBytes))),
	)
	wire := fieldDelta(1, de.TypeMap)
	wire = append(wire, mapHeader(1, de.TypeInt32, de.TypeBytes)...)
	wire = append(wire, int32Value(4)...)
	wire = append(wire, uleb(zz32(2))...)
	wire = append(wire, []byte{'o', 'k'}...)
	wire = append(wire, structEnd()...)

	d := de.NewDecoder(schema)
	if n, err := d.Write(wire); err != nil || n != len(wire) {
		t.Fatalf("Write = (%d, %v), want (%d, nil)", n, err, len(wire))
	}
	got, err := d.Decode()
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	if d.Err() != nil {
		t.Fatalf("Err = %v, want nil", d.Err())
	}

	field, ok := got.LookupField(1)
	if !ok {
		t.Fatalf("field 1 missing")
	}
	value, ok := field.LookupEntry(de.Value{Type: de.TypeInt32, Int: 4})
	if !ok {
		t.Fatalf("map key 4 missing")
	}
	if !reflect.DeepEqual(value.Bytes, []byte("ok")) {
		t.Fatalf("map value = %#v, want []byte(\"ok\")", value.Bytes)
	}

	fieldMap, ok := got.Interface().(map[uint32]any)
	if !ok {
		t.Fatalf("struct Interface type = %T, want map[uint32]any", got.Interface())
	}
	if _, ok := fieldMap[1]; !ok {
		t.Fatalf("struct Interface missing field 1")
	}
}

func TestShortestAndWidestVarintsAccepted(t *testing.T) {
	// Single-byte zero is the shortest possible varint.
	emptyMapSchema := de.Map(de.Scalar(de.TypeInt32), de.Scalar(de.TypeInt32))
	got, err := de.Decode([]byte{0x00}, emptyMapSchema)
	if err != nil {
		t.Fatalf("empty map: %v", err)
	}
	if got.Type != de.TypeMap || len(got.Entries) != 0 {
		t.Fatalf("empty map = %#v", got)
	}

	// The 32-bit and 64-bit extremes exercise the maximum legal final bytes.
	schema := de.Struct(
		de.FieldOf(1, de.TypeInt32),
		de.FieldOf(2, de.TypeInt64),
	)
	wire := fieldDelta(1, de.TypeInt32)
	wire = append(wire, 0xff, 0xff, 0xff, 0xff, 0x0f)
	wire = append(wire, fieldDelta(1, de.TypeInt64)...)
	wire = append(wire, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01)
	wire = append(wire, structEnd()...)
	got, err = de.Decode(wire, schema)
	if err != nil {
		t.Fatalf("wide varints: %v", err)
	}
	want := &de.Value{Type: de.TypeStruct, Fields: []de.FieldValue{
		{ID: 1, Value: de.Value{Type: de.TypeInt32, Int: -2147483648}},
		{ID: 2, Value: de.Value{Type: de.TypeInt64, Int: -9223372036854775808}},
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("value mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestNegativeQuantitiesRejected(t *testing.T) {
	t.Run("list count", func(t *testing.T) {
		wire := []byte{0xf0 | byte(de.TypeInt32)}
		wire = append(wire, uleb(zz32(-1))...)
		_, err := de.Decode(wire, de.List(de.Scalar(de.TypeInt32)))
		if !errors.Is(err, de.ErrNegativeQuantity) {
			t.Fatalf("err = %v, want ErrNegativeQuantity", err)
		}
	})

	t.Run("map count", func(t *testing.T) {
		wire := uleb(zz32(-3))
		_, err := de.Decode(wire, de.Map(
			de.Scalar(de.TypeInt32),
			de.Scalar(de.TypeInt32),
		))
		if !errors.Is(err, de.ErrNegativeQuantity) {
			t.Fatalf("err = %v, want ErrNegativeQuantity", err)
		}
	})

	t.Run("byte length", func(t *testing.T) {
		wire := fieldDelta(1, de.TypeBytes)
		wire = append(wire, uleb(zz32(-2))...)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, de.Struct(de.FieldOf(1, de.TypeBytes)))
		if !errors.Is(err, de.ErrNegativeQuantity) {
			t.Fatalf("err = %v, want ErrNegativeQuantity", err)
		}
	})

	t.Run("absolute field identifier", func(t *testing.T) {
		wire := fieldAbs(de.TypeInt32, -1)
		wire = append(wire, int32Value(1)...)
		wire = append(wire, structEnd()...)
		_, err := de.Decode(wire, de.Struct(de.FieldOf(1, de.TypeInt32)))
		if !errors.Is(err, de.ErrFieldID) {
			t.Fatalf("err = %v, want ErrFieldID", err)
		}
	})
}

func TestEmptyStructureAndSet(t *testing.T) {
	got, err := de.Decode([]byte{0x00}, de.Struct())
	if err != nil {
		t.Fatalf("empty struct: %v", err)
	}
	want := &de.Value{Type: de.TypeStruct, Fields: []de.FieldValue{}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("empty struct mismatch: %#v", got)
	}

	got, err = de.Decode(listHeader(0, de.TypeByte), de.Set(de.Scalar(de.TypeByte)))
	if err != nil {
		t.Fatalf("empty set: %v", err)
	}
	want = &de.Value{Type: de.TypeSet, Elements: []de.Value{}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("empty set mismatch: %#v", got)
	}
}
