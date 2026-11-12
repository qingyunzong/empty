package dataeng_test

import (
	"errors"
	"math/rand"
	"reflect"
	"testing"

	de "example.org/dataeng/q0320"
	"example.org/dataeng/q0320/internal/s8fixture"
	"example.org/dataeng/q0320/internal/s8ref"
)

func add(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func mixedScenario(t *testing.T) (de.Config, []byte, []s8fixture.Location) {
	t.Helper()
	cfg := de.Config{
		Fields: []de.Field{
			de.NumericField("id"),
			de.BytesField("name", 10),
			de.NumericField("score"),
			de.BytesField("note", 3),
		},
		NumericEndian: de.LittleEndian,
		Bias:          100,
		MaxRows:       100,
		RowByteBudget: 64,
	}

	b := s8fixture.New(s8fixture.Little)

	// Row 1: negative zero, a string containing 0x00 and 0xff, a NaN
	// literal, and a spaces opcode.
	add(t, b.AddNumericLiteral(0x8000000000000000))
	add(t, b.AddBytesLiteral([8]byte{0x00, 0xff, 'a', 'b', 'c', 'd', 'e', 'f'}))
	add(t, b.AddBytesLiteral([8]byte{'g', 'h', ' ', ' ', ' ', ' ', ' ', ' '}))
	add(t, b.AddNumericLiteral(0x7ff8000000000001))
	add(t, b.AddSpaces())

	// Row 2: integer opcode, multi-slot string, system missing via 255.
	add(t, b.AddCode(42, cfg.Bias))
	add(t, b.AddBytesLiteral([8]byte{'h', 'e', 'l', 'l', 'o', ' ', ' ', ' '}))
	add(t, b.AddSpaces())
	add(t, b.AddMissing())
	add(t, b.AddSpaces())

	// Row 3: integer opcode, string, system missing via the fixed 253 bit
	// pattern, and bytes containing 0x00 and 0xff.
	add(t, b.AddCode(-5, cfg.Bias))
	add(t, b.AddBytesLiteral([8]byte{'x', ' ', ' ', ' ', ' ', ' ', ' ', ' '}))
	add(t, b.AddSpaces())
	add(t, b.AddNumericLiteral(0xffefffffffffffff))
	add(t, b.AddBytesLiteral([8]byte{0x00, 0xff, 'Z', ' ', ' ', ' ', ' ', ' '}))

	add(t, b.AddTerminator())

	data, locs, err := b.Encode()
	add(t, err)
	return cfg, data, locs
}

func longBytesScenario(t *testing.T) (de.Config, []byte, []s8fixture.Location) {
	t.Helper()
	cfg := de.Config{
		Fields: []de.Field{
			de.NumericField("k"),
			de.BytesField("blob", 160),
		},
		NumericEndian: de.LittleEndian,
		Bias:          7,
		MaxRows:       10,
		RowByteBudget: 256,
	}

	payload := make([]byte, 150)
	for i := range payload {
		payload[i] = byte(i*37 + 11)
	}
	payload[0] = 0x00
	payload[1] = 0xff

	slots, err := s8fixture.PadBytes(160, payload)
	add(t, err)

	b := s8fixture.New(s8fixture.Little)
	add(t, b.AddCode(10, cfg.Bias))
	for _, slot := range slots {
		add(t, b.AddBytesLiteral(slot))
	}
	add(t, b.AddTerminator())

	data, locs, err := b.Encode()
	add(t, err)
	return cfg, data, locs
}

func lastLiteralScenario(t *testing.T) (de.Config, []byte, []s8fixture.Location) {
	t.Helper()
	cfg := de.Config{
		Fields:        []de.Field{de.NumericField("n")},
		NumericEndian: de.LittleEndian,
		Bias:          3,
		MaxRows:       4,
		RowByteBudget: 8,
	}

	b := s8fixture.New(s8fixture.Little)
	add(t, b.AddNumericLiteral(0x3ff0000000000000))
	add(t, b.AddTerminator())

	data, locs, err := b.Encode()
	add(t, err)
	return cfg, data, locs
}

func paddingScenario(t *testing.T) (de.Config, []byte, []s8fixture.Location) {
	t.Helper()
	cfg := de.Config{
		Fields: []de.Field{
			de.NumericField("n"),
			de.BytesField("b", 8),
		},
		NumericEndian: de.LittleEndian,
		Bias:          100,
		MaxRows:       4,
		RowByteBudget: 8,
	}

	b := s8fixture.New(s8fixture.Little)
	add(t, b.Add(0, nil))
	add(t, b.AddCode(7, cfg.Bias))
	add(t, b.Add(0, nil))
	add(t, b.AddBytesLiteral([8]byte{0x00, 0xff, 'p', 'a', 'd', 'd', 'e', 'd'}))
	add(t, b.AddTerminator())

	data, locs, err := b.Encode()
	add(t, err)
	return cfg, data, locs
}

func decodeWithCuts(t *testing.T, cfg de.Config, data []byte, cuts []int) ([]de.Row, error) {
	t.Helper()
	d, err := de.NewDecoder(cfg)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	rows := make([]de.Row, 0)
	start := 0
	for _, cut := range cuts {
		if cut < start || cut > len(data) {
			t.Fatalf("bad cut %d (start %d, len %d)", cut, start, len(data))
		}
		got, err := d.Push(data[start:cut])
		rows = append(rows, got...)
		if err != nil {
			return rows, err
		}
		start = cut
	}
	got, err := d.Push(data[start:])
	rows = append(rows, got...)
	if err != nil {
		return rows, err
	}
	if err := d.Finish(); err != nil {
		return rows, err
	}
	return rows, nil
}

func checkAllChunkings(t *testing.T, cfg de.Config, data []byte) {
	t.Helper()
	refRows, complete, err := s8ref.Decode(data, cfg)
	if err != nil {
		t.Fatalf("reference decode: %v", err)
	}
	if !complete {
		t.Fatal("reference did not report complete")
	}

	check := func(name string, cuts []int) {
		t.Helper()
		rows, err := decodeWithCuts(t, cfg, data, cuts)
		if err != nil {
			t.Fatalf("%s decode: %v", name, err)
		}
		if !reflect.DeepEqual(rows, refRows) {
			t.Fatalf("%s rows differ from reference:\n got %#v\nwant %#v", name, rows, refRows)
		}
	}

	for split := 0; split <= len(data); split++ {
		check("split", []int{split})
	}
	for size := 1; size <= len(data); size++ {
		cuts := make([]int, 0, len(data)/size)
		for cut := size; cut < len(data); cut += size {
			cuts = append(cuts, cut)
		}
		check("fixed chunk", cuts)
	}

	rng := rand.New(rand.NewSource(0x5a17))
	for trial := 0; trial < 200; trial++ {
		cuts := make([]int, 0, 8)
		pos := 0
		for pos < len(data) {
			pos += 1 + rng.Intn(11)
			if pos >= len(data) {
				break
			}
			cuts = append(cuts, pos)
		}
		check("random partition", cuts)
	}
}

func checkTruncationAtEveryByte(t *testing.T, cfg de.Config, data []byte) {
	t.Helper()
	for prefix := 0; prefix < len(data); prefix++ {
		d, err := de.NewDecoder(cfg)
		if err != nil {
			t.Fatalf("NewDecoder: %v", err)
		}
		rows, pushErr := d.Push(data[:prefix])
		if pushErr != nil {
			t.Fatalf("prefix %d: unexpected Push error: %v", prefix, pushErr)
		}
		finishErr := d.Finish()
		if finishErr == nil {
			t.Fatalf("prefix %d: Finish succeeded without terminator", prefix)
		}
		if !errors.Is(finishErr, de.ErrTruncated) {
			t.Fatalf("prefix %d: Finish error = %v, want truncated", prefix, finishErr)
		}

		refRows, _, refErr := s8ref.Decode(data[:prefix], cfg)
		if refErr == nil || !errors.Is(refErr, de.ErrTruncated) {
			t.Fatalf("prefix %d: reference error = %v, want truncated", prefix, refErr)
		}
		if !reflect.DeepEqual(rows, refRows) {
			t.Fatalf("prefix %d rows differ:\n got %#v\nwant %#v", prefix, rows, refRows)
		}
	}
}
