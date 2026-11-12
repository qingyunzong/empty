package rowlayout_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"testing"

	"example.org/dataeng/q0197/rowlayout"
)

func mustSchema(t *testing.T, fields []rowlayout.Field) *rowlayout.Schema {
	t.Helper()
	schema, err := rowlayout.NewSchema(fields)
	if err != nil {
		t.Fatalf("NewSchema() error = %v", err)
	}
	return schema
}

func allSchemas(n int) [][]rowlayout.Field {
	types := []rowlayout.FieldType{rowlayout.Int64, rowlayout.Bool, rowlayout.Bytes}
	var out [][]rowlayout.Field
	var build func(acc []rowlayout.Field)
	build = func(acc []rowlayout.Field) {
		if len(acc) == n {
			out = append(out, append([]rowlayout.Field(nil), acc...))
			return
		}
		for _, fieldType := range types {
			next := append(append([]rowlayout.Field(nil), acc...),
				rowlayout.Field{Name: fmt.Sprintf("f%d", len(acc)), Type: fieldType})
			build(next)
		}
	}
	build(nil)
	return out
}

func sampleValue(fieldType rowlayout.FieldType, index int) rowlayout.Value {
	switch fieldType {
	case rowlayout.Int64:
		ints := []int64{0, 1, -1, 42, math.MaxInt64, math.MinInt64}
		return rowlayout.Value{Int: ints[index%len(ints)]}
	case rowlayout.Bool:
		return rowlayout.Value{Bool: index%2 == 0}
	case rowlayout.Bytes:
		bodies := [][]byte{
			{},
			{0x01},
			[]byte("hello"),
			bytes.Repeat([]byte{0xab}, 9),
			{0, 1, 2, 3, 4, 5, 6, 7},
		}
		return rowlayout.Value{Bytes: bodies[index%len(bodies)]}
	default:
		panic("unknown field type")
	}
}

func encodeField(field rowlayout.Field, value rowlayout.Value) []byte {
	switch field.Type {
	case rowlayout.Int64:
		out := make([]byte, 8)
		binary.LittleEndian.PutUint64(out, uint64(value.Int))
		return out
	case rowlayout.Bool:
		if value.Bool {
			return []byte{1}
		}
		return []byte{0}
	case rowlayout.Bytes:
		out := make([]byte, 4+len(value.Bytes))
		binary.LittleEndian.PutUint32(out, uint32(len(value.Bytes)))
		copy(out[4:], value.Bytes)
		return out
	}
	panic("unknown field type")
}

func valuesEqual(t *testing.T, field rowlayout.Field, got, want rowlayout.Value) {
	t.Helper()
	if got.Null != want.Null {
		t.Fatalf("null mismatch: got %v want %v", got.Null, want.Null)
	}
	if got.Null {
		return
	}
	switch field.Type {
	case rowlayout.Int64:
		if got.Int != want.Int {
			t.Fatalf("int mismatch: got %d want %d", got.Int, want.Int)
		}
	case rowlayout.Bool:
		if got.Bool != want.Bool {
			t.Fatalf("bool mismatch: got %v want %v", got.Bool, want.Bool)
		}
	case rowlayout.Bytes:
		if !bytes.Equal(got.Bytes, want.Bytes) {
			t.Fatalf("bytes mismatch: got %v want %v", got.Bytes, want.Bytes)
		}
	}
}

// Every short schema (up to four fields) is exercised under every null
// combination, so field offsets must be derived from the bitmap rather than
// fixed per field number.
func TestExhaustiveRoundTrip(t *testing.T) {
	for n := 0; n <= 4; n++ {
		for _, fields := range allSchemas(n) {
			schema := mustSchema(t, fields)
			base := make([]rowlayout.Value, n)
			for i := range base {
				base[i] = sampleValue(fields[i].Type, i)
			}

			for mask := 0; mask < 1<<n; mask++ {
				values := make([]rowlayout.Value, n)
				copy(values, base)
				for i := range values {
					if mask&(1<<i) == 0 {
						values[i] = rowlayout.Value{Null: true}
					}
				}

				line, err := rowlayout.Encode(schema, values)
				if err != nil {
					t.Fatalf("n=%d fields=%v mask=%#b Encode() error = %v",
						n, fields, mask, err)
				}
				if n > 0 && len(line)%8 != 0 {
					t.Fatalf("line length %d is not 8-byte aligned", len(line))
				}

				bitmapLen := (n + 7) / 8
				for i := range fields {
					if !values[i].Null && line[i/8]&(1<<(i%8)) == 0 {
						t.Fatalf("bitmap missing non-null field %d", i)
					}
					if values[i].Null && line[i/8]&(1<<(i%8)) != 0 {
						t.Fatalf("bitmap marks null field %d as present", i)
					}
				}
				if used := n % 8; used != 0 && bitmapLen > 0 {
					if line[bitmapLen-1]&(byte(0xff)<<used) != 0 {
						t.Fatalf("unused bitmap bits are set: %#v", line[:bitmapLen])
					}
				}

				row, err := rowlayout.Decode(schema, line, len(line))
				if err != nil {
					t.Fatalf("n=%d fields=%v mask=%#b Decode() error = %v",
						n, fields, mask, err)
				}
				if len(row.Values) != n || len(row.Ranges) != n {
					t.Fatalf("decoded row has %d values and %d ranges, want %d",
						len(row.Values), len(row.Ranges), n)
				}

				payloadEnd := bitmapLen
				for i, field := range fields {
					valuesEqual(t, field, row.Values[i], values[i])
					gotRange := row.Ranges[i]
					if values[i].Null {
						if !gotRange.Null || gotRange.Start != 0 || gotRange.End != 0 {
							t.Fatalf("null field %d has range %+v", i, gotRange)
						}
						continue
					}
					if gotRange.Null || gotRange.Start != payloadEnd || gotRange.End <= gotRange.Start {
						t.Fatalf("field %d has bad range %+v, want start %d",
							i, gotRange, payloadEnd)
					}
					wantBytes := encodeField(field, values[i])
					if !bytes.Equal(line[gotRange.Start:gotRange.End], wantBytes) {
						t.Fatalf("field %d wire bytes %v, want %v",
							i, line[gotRange.Start:gotRange.End], wantBytes)
					}
					payloadEnd = gotRange.End
				}

				pad := (8 - payloadEnd%8) % 8
				if len(line) != payloadEnd+pad {
					t.Fatalf("line length %d, payload ends at %d, pad %d",
						len(line), payloadEnd, pad)
				}
				for offset, paddingByte := range line[payloadEnd:] {
					if paddingByte != 0 {
						t.Fatalf("non-zero padding at %d: %d", payloadEnd+offset, paddingByte)
					}
				}

				again, err := rowlayout.Encode(schema, row.Values)
				if err != nil {
					t.Fatalf("re-Encode() error = %v", err)
				}
				if !bytes.Equal(again, line) {
					t.Fatalf("inverse encoding mismatch:\n got %v\nwant %v", again, line)
				}
			}
		}
	}
}

func TestOffsetsDependOnNullMask(t *testing.T) {
	schema := mustSchema(t, []rowlayout.Field{
		{Name: "i", Type: rowlayout.Int64},
		{Name: "b", Type: rowlayout.Bool},
		{Name: "s", Type: rowlayout.Bytes},
	})
	full := []rowlayout.Value{
		{Int: 7},
		{Bool: true},
		{Bytes: []byte{1, 2, 3}},
	}
	lineFull, err := rowlayout.Encode(schema, full)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	rowFull, err := rowlayout.Decode(schema, lineFull, len(lineFull))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}

	middleNull := []rowlayout.Value{full[0], rowlayout.Value{Null: true}, full[2]}
	lineNull, err := rowlayout.Encode(schema, middleNull)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	rowNull, err := rowlayout.Decode(schema, lineNull, len(lineNull))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}

	if rowFull.Ranges[2].Start == rowNull.Ranges[2].Start {
		t.Fatalf("field 2 offset is fixed at %d regardless of null mask",
			rowFull.Ranges[2].Start)
	}
	if rowNull.Ranges[1].Start != 0 || !rowNull.Ranges[1].Null {
		t.Fatalf("null field range = %+v", rowNull.Ranges[1])
	}
}

func TestWireFormat(t *testing.T) {
	schema := mustSchema(t, []rowlayout.Field{
		{Name: "i", Type: rowlayout.Int64},
		{Name: "b", Type: rowlayout.Bool},
		{Name: "s", Type: rowlayout.Bytes},
	})
	line, err := rowlayout.Encode(schema, []rowlayout.Value{
		{Int: 1},
		{Bool: true},
		{Bytes: []byte{1, 2, 3}},
	})
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}

	want := make([]byte, 24)
	want[0] = 0x07
	binary.LittleEndian.PutUint64(want[1:9], 1)
	want[9] = 0x01
	binary.LittleEndian.PutUint32(want[10:14], 3)
	copy(want[14:17], []byte{1, 2, 3})
	if !bytes.Equal(line, want) {
		t.Fatalf("wire format mismatch:\n got %v\nwant %v", line, want)
	}

	intSchema := mustSchema(t, []rowlayout.Field{{Name: "i", Type: rowlayout.Int64}})
	minLine, err := rowlayout.Encode(intSchema, []rowlayout.Value{{Int: math.MinInt64}})
	if err != nil {
		t.Fatalf("Encode(MinInt64) error = %v", err)
	}
	wantMin := []byte{0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0, 0, 0, 0, 0, 0, 0}
	if !bytes.Equal(minLine, wantMin) {
		t.Fatalf("MinInt64 line = %v, want %v", minLine, wantMin)
	}
}

func TestMalformedRejected(t *testing.T) {
	schema := mustSchema(t, []rowlayout.Field{
		{Name: "i", Type: rowlayout.Int64},
		{Name: "b", Type: rowlayout.Bool},
		{Name: "s", Type: rowlayout.Bytes},
	})
	goodValues := []rowlayout.Value{
		{Int: 7},
		{Bool: true},
		{Bytes: []byte{1, 2, 3}},
	}
	good, err := rowlayout.Encode(schema, goodValues)
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	goodRow, err := rowlayout.Decode(schema, good, len(good))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}

	clone := func() []byte { return append([]byte(nil), good...) }

	t.Run("non-zero padding", func(t *testing.T) {
		bad := clone()
		bad[len(bad)-1] = 0xff
		_, err := rowlayout.Decode(schema, bad, len(bad))
		if !errors.Is(err, rowlayout.ErrNonZeroPadding) {
			t.Fatalf("error = %v, want ErrNonZeroPadding", err)
		}
	})

	t.Run("unused bitmap bits", func(t *testing.T) {
		bad := clone()
		bad[0] |= 0x80
		_, err := rowlayout.Decode(schema, bad, len(bad))
		if !errors.Is(err, rowlayout.ErrInvalidBitmap) {
			t.Fatalf("error = %v, want ErrInvalidBitmap", err)
		}
	})

	t.Run("byte string length out of range", func(t *testing.T) {
		bad := clone()
		strStart := goodRow.Ranges[2].Start
		binary.LittleEndian.PutUint32(bad[strStart:strStart+4], math.MaxUint32)
		_, err := rowlayout.Decode(schema, bad, len(bad))
		if !errors.Is(err, rowlayout.ErrLengthOutOfRange) {
			t.Fatalf("error = %v, want ErrLengthOutOfRange", err)
		}
	})

	t.Run("invalid bool byte", func(t *testing.T) {
		bad := clone()
		bad[goodRow.Ranges[1].Start] = 2
		_, err := rowlayout.Decode(schema, bad, len(bad))
		if !errors.Is(err, rowlayout.ErrInvalidBool) {
			t.Fatalf("error = %v, want ErrInvalidBool", err)
		}
	})

	t.Run("full extra zero block", func(t *testing.T) {
		bad := append(clone(), make([]byte, 8)...)
		_, err := rowlayout.Decode(schema, bad, len(bad))
		if !errors.Is(err, rowlayout.ErrTrailingBytes) {
			t.Fatalf("error = %v, want ErrTrailingBytes", err)
		}
	})

	t.Run("misaligned trailing byte", func(t *testing.T) {
		bad := append(clone(), 0)
		_, err := rowlayout.Decode(schema, bad, len(bad))
		if !errors.Is(err, rowlayout.ErrTrailingBytes) {
			t.Fatalf("error = %v, want ErrTrailingBytes", err)
		}
	})

	t.Run("truncated field", func(t *testing.T) {
		bad := clone()
		bad = bad[:goodRow.Ranges[2].End-1]
		_, err := rowlayout.Decode(schema, bad, len(bad))
		if !errors.Is(err, rowlayout.ErrLengthOutOfRange) && !errors.Is(err, rowlayout.ErrTruncated) {
			t.Fatalf("error = %v, want length/truncated error", err)
		}
	})

	t.Run("truncated bitmap", func(t *testing.T) {
		_, err := rowlayout.Decode(schema, []byte{}, 8)
		if !errors.Is(err, rowlayout.ErrEmptyLine) {
			t.Fatalf("error = %v, want ErrEmptyLine", err)
		}
	})

	t.Run("line too long", func(t *testing.T) {
		_, err := rowlayout.Decode(schema, good, len(good)-1)
		if !errors.Is(err, rowlayout.ErrLineTooLong) {
			t.Fatalf("error = %v, want ErrLineTooLong", err)
		}
		if _, err := rowlayout.Decode(schema, good, -1); !errors.Is(err, rowlayout.ErrLineTooLong) {
			t.Fatalf("negative limit error = %v, want ErrLineTooLong", err)
		}
	})

	t.Run("max length boundary accepted", func(t *testing.T) {
		if _, err := rowlayout.Decode(schema, good, len(good)); err != nil {
			t.Fatalf("Decode() at exact max length error = %v", err)
		}
	})
}

func TestDecodedBytesAreCopied(t *testing.T) {
	schema := mustSchema(t, []rowlayout.Field{{Name: "s", Type: rowlayout.Bytes}})
	line, err := rowlayout.Encode(schema, []rowlayout.Value{{Bytes: []byte("abc")}})
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	row, err := rowlayout.Decode(schema, line, len(line))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	row.Values[0].Bytes[0] = 'z'
	if line[5] != 'a' {
		t.Fatalf("decoded bytes alias the input line: line=%v", line)
	}
}

func TestEmptyAndInvalidSchema(t *testing.T) {
	empty, err := rowlayout.NewSchema(nil)
	if err != nil {
		t.Fatalf("NewSchema(nil) error = %v", err)
	}
	line, err := rowlayout.Encode(empty, nil)
	if err != nil {
		t.Fatalf("Encode(empty) error = %v", err)
	}
	if len(line) != 0 {
		t.Fatalf("empty schema line = %v, want empty", line)
	}
	row, err := rowlayout.Decode(empty, nil, 0)
	if err != nil {
		t.Fatalf("Decode(empty, nil) error = %v", err)
	}
	if len(row.Values) != 0 || len(row.Ranges) != 0 {
		t.Fatalf("empty schema decoded row = %+v", row)
	}

	if _, err := rowlayout.NewSchema([]rowlayout.Field{{Type: 0}}); !errors.Is(err, rowlayout.ErrInvalidSchema) {
		t.Fatalf("unknown type error = %v, want ErrInvalidSchema", err)
	}
	if _, err := rowlayout.Encode(nil, nil); !errors.Is(err, rowlayout.ErrInvalidSchema) {
		t.Fatalf("nil schema Encode error = %v, want ErrInvalidSchema", err)
	}
	if _, err := rowlayout.Decode(nil, []byte{0}, 8); !errors.Is(err, rowlayout.ErrInvalidSchema) {
		t.Fatalf("nil schema Decode error = %v, want ErrInvalidSchema", err)
	}

	schema := mustSchema(t, []rowlayout.Field{{Name: "i", Type: rowlayout.Int64}})
	if _, err := rowlayout.Encode(schema, nil); !errors.Is(err, rowlayout.ErrInvalidValue) {
		t.Fatalf("value count error = %v, want ErrInvalidValue", err)
	}
	if _, err := rowlayout.Encode(schema, []rowlayout.Value{{}, {}}); !errors.Is(err, rowlayout.ErrInvalidValue) {
		t.Fatalf("value count error = %v, want ErrInvalidValue", err)
	}
}

func TestNullIsExplicit(t *testing.T) {
	schema := mustSchema(t, []rowlayout.Field{{Name: "s", Type: rowlayout.Bytes}})
	emptyBytes, err := rowlayout.Encode(schema, []rowlayout.Value{{Bytes: nil}})
	if err != nil {
		t.Fatalf("Encode(empty bytes) error = %v", err)
	}
	row, err := rowlayout.Decode(schema, emptyBytes, len(emptyBytes))
	if err != nil {
		t.Fatalf("Decode(empty bytes) error = %v", err)
	}
	if row.Values[0].Null || !bytes.Equal(row.Values[0].Bytes, []byte{}) {
		t.Fatalf("nil non-null Bytes decoded as %+v, want empty non-null", row.Values[0])
	}

	nullLine, err := rowlayout.Encode(schema, []rowlayout.Value{{Null: true}})
	if err != nil {
		t.Fatalf("Encode(null) error = %v", err)
	}
	nullRow, err := rowlayout.Decode(schema, nullLine, len(nullLine))
	if err != nil {
		t.Fatalf("Decode(null) error = %v", err)
	}
	if !nullRow.Values[0].Null {
		t.Fatalf("null value decoded as %+v", nullRow.Values[0])
	}
	if !bytes.Equal(nullLine, []byte{0, 0, 0, 0, 0, 0, 0, 0}) {
		t.Fatalf("null-only line = %v", nullLine)
	}
}

func TestSchemaAccessorsAndCopy(t *testing.T) {
	original := []rowlayout.Field{{Name: "i", Type: rowlayout.Int64}, {Name: "b", Type: rowlayout.Bool}}
	schema := mustSchema(t, original)
	if schema.Len() != 2 || schema.Field(1).Name != "b" {
		t.Fatalf("schema accessors returned %+v, %q", schema.Field(1), schema.Field(1).Name)
	}
	copied := schema.Fields()
	copied[0].Name = "mutated"
	if schema.Field(0).Name != "i" {
		t.Fatalf("Fields() did not return an independent copy: %+v", schema.Fields())
	}

	schema2, err := rowlayout.NewSchema(original)
	if err != nil {
		t.Fatalf("NewSchema() error = %v", err)
	}
	if schema2.Field(0).Name != "i" {
		t.Fatalf("NewSchema did not copy fields")
	}
}

func TestTruncatedRejected(t *testing.T) {
	schema := mustSchema(t, []rowlayout.Field{
		{Name: "i", Type: rowlayout.Int64},
		{Name: "b", Type: rowlayout.Bool},
	})

	t.Run("bitmap only", func(t *testing.T) {
		line := []byte{0x03}
		_, err := rowlayout.Decode(schema, line, 8)
		if !errors.Is(err, rowlayout.ErrTruncated) {
			t.Fatalf("error = %v, want ErrTruncated", err)
		}
	})

	t.Run("line shorter than bitmap", func(t *testing.T) {
		big := mustSchema(t, []rowlayout.Field{
			{Name: "i0", Type: rowlayout.Int64},
			{Name: "i1", Type: rowlayout.Int64},
			{Name: "i2", Type: rowlayout.Int64},
			{Name: "i3", Type: rowlayout.Int64},
			{Name: "i4", Type: rowlayout.Int64},
			{Name: "i5", Type: rowlayout.Int64},
			{Name: "i6", Type: rowlayout.Int64},
			{Name: "i7", Type: rowlayout.Int64},
			{Name: "i8", Type: rowlayout.Int64},
		})
		_, err := rowlayout.Decode(big, []byte{0}, 8)
		if !errors.Is(err, rowlayout.ErrTruncated) {
			t.Fatalf("error = %v, want ErrTruncated", err)
		}
	})

	t.Run("int64 cut short", func(t *testing.T) {
		line := []byte{0x01, 1, 2, 3}
		_, err := rowlayout.Decode(schema, line, 8)
		if !errors.Is(err, rowlayout.ErrTruncated) {
			t.Fatalf("error = %v, want ErrTruncated", err)
		}
	})

	t.Run("bool missing", func(t *testing.T) {
		boolSchema := mustSchema(t, []rowlayout.Field{{Name: "b", Type: rowlayout.Bool}})
		line := []byte{0x01}
		_, err := rowlayout.Decode(boolSchema, line, 8)
		if !errors.Is(err, rowlayout.ErrTruncated) {
			t.Fatalf("error = %v, want ErrTruncated", err)
		}
	})

	t.Run("bytes length prefix cut short", func(t *testing.T) {
		bytesSchema := mustSchema(t, []rowlayout.Field{{Name: "s", Type: rowlayout.Bytes}})
		for _, line := range [][]byte{
			{0x01},
			{0x01, 0x05},
			{0x01, 0x05, 0x00},
			{0x01, 0x05, 0x00, 0x00},
		} {
			_, err := rowlayout.Decode(bytesSchema, line, 8)
			if !errors.Is(err, rowlayout.ErrTruncated) {
				t.Fatalf("line %v error = %v, want ErrTruncated", line, err)
			}
		}
	})
}
