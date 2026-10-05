package wiremsg

import (
	"bytes"
	"errors"
	"fmt"
	"math/rand"
	"testing"
)

// ---------------------------------------------------------------------------
// Independent field scanner: a deliberately separate implementation used to
// cross-check the library's parser. It shares no code with wiremsg.go.
// ---------------------------------------------------------------------------

type scannedField struct {
	Offset int
	Number int
	Type   int
	Raw    []byte // value bytes only (content for length-delimited)
}

func scanFields(t *testing.T, data []byte) []scannedField {
	t.Helper()
	var out []scannedField
	pos := 0
	readUvarint := func() uint64 {
		var v uint64
		for i := 0; ; i++ {
			if pos >= len(data) {
				t.Fatalf("scanner: truncated varint at %d", pos)
			}
			b := data[pos]
			pos++
			v |= uint64(b&0x7f) << (7 * i)
			if b < 0x80 {
				return v
			}
			if i == 9 {
				t.Fatalf("scanner: varint overflow at %d", pos)
			}
		}
	}
	for pos < len(data) {
		start := pos
		tag := readUvarint()
		num, wt := int(tag>>3), int(tag&7)
		var raw []byte
		switch wt {
		case 0:
			vstart := pos
			readUvarint()
			raw = data[vstart:pos]
		case 1:
			raw = data[pos : pos+8]
			pos += 8
		case 2:
			l := int(readUvarint())
			raw = data[pos : pos+l]
			pos += l
		case 5:
			raw = data[pos : pos+4]
			pos += 4
		default:
			t.Fatalf("scanner: illegal wire type %d at %d", wt, start)
		}
		out = append(out, scannedField{Offset: start, Number: num, Type: wt, Raw: raw})
	}
	return out
}

// ---------------------------------------------------------------------------
// Random message generation
// ---------------------------------------------------------------------------

func randomMessage(r *rand.Rand, depth int) *Message {
	m := New()
	n := 1 + r.Intn(8)
	used := map[int]bool{}
	for i := 0; i < n; i++ {
		num := 1 + r.Intn(12)
		used[num] = true
		switch r.Intn(4) {
		case 0:
			if err := m.AppendVarint(num, r.Uint64()); err != nil {
				panic(err)
			}
		case 1:
			b := make([]byte, 8)
			r.Read(b)
			if err := m.Append(num, Fixed64, b); err != nil {
				panic(err)
			}
		case 2:
			b := make([]byte, r.Intn(20))
			r.Read(b)
			if err := m.AppendBytes(num, b); err != nil {
				panic(err)
			}
		case 3:
			if depth < 3 && r.Intn(2) == 0 {
				sub := randomMessage(r, depth+1)
				if err := m.AppendBytes(num, sub.Marshal()); err != nil {
					panic(err)
				}
			} else {
				b := make([]byte, 4)
				r.Read(b)
				if err := m.Append(num, Fixed32, b); err != nil {
					panic(err)
				}
			}
		}
	}
	return m
}

// assertMatchesScanner cross-checks a parsed message against the independent
// scanner over the same bytes.
func assertMatchesScanner(t *testing.T, m *Message, data []byte) {
	t.Helper()
	want := scanFields(t, data)
	got := m.All()
	if len(got) != len(want) {
		t.Fatalf("field count mismatch: lib=%d scanner=%d", len(got), len(want))
	}
	for i := range want {
		if got[i].Number != want[i].Number || int(got[i].Type) != want[i].Type ||
			!bytes.Equal(got[i].Raw, want[i].Raw) {
			t.Fatalf("field %d mismatch: lib=%+v scanner=%+v", i, got[i], want[i])
		}
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

func TestRandomRoundTrip(t *testing.T) {
	for seed := int64(0); seed < 500; seed++ {
		r := rand.New(rand.NewSource(seed))
		m := randomMessage(r, 0)
		data := m.Marshal()

		parsed, err := Parse(data)
		if err != nil {
			t.Fatalf("seed %d: parse failed: %v", seed, err)
		}
		if got := parsed.Marshal(); !bytes.Equal(got, data) {
			t.Fatalf("seed %d: round-trip mismatch\n got %x\nwant %x", seed, got, data)
		}
		assertMatchesScanner(t, parsed, data)

		// Nested messages must also round-trip byte-identically.
		for _, f := range parsed.All() {
			if f.Type != Bytes {
				continue
			}
			sub, err := Parse(f.Raw)
			if err != nil {
				continue // random bytes need not be a valid message
			}
			if got := sub.Marshal(); !bytes.Equal(got, f.Raw) {
				t.Fatalf("seed %d: nested round-trip mismatch", seed)
			}
		}
	}
}

func TestModifyKnownFieldPreservesUnknownOrder(t *testing.T) {
	for seed := int64(0); seed < 300; seed++ {
		r := rand.New(rand.NewSource(1000 + seed))
		m := randomMessage(r, 0)
		known := 1 + r.Intn(12)
		before := m.Marshal()

		// Unknown fields for this test = every field except `known`.
		unknownBefore := filterOut(scanFields(t, before), known)

		newVals := []uint64{r.Uint64(), r.Uint64()}
		m.SetVarints(known, newVals...)
		after := m.Marshal()

		parsed, err := Parse(after)
		if err != nil {
			t.Fatalf("seed %d: re-parse failed: %v", seed, err)
		}
		assertMatchesScanner(t, parsed, after)

		unknownAfter := filterOut(scanFields(t, after), known)
		if len(unknownBefore) != len(unknownAfter) {
			t.Fatalf("seed %d: unknown count changed: %d -> %d", seed, len(unknownBefore), len(unknownAfter))
		}
		for i := range unknownBefore {
			a, b := unknownBefore[i], unknownAfter[i]
			if a.Number != b.Number || a.Type != b.Type || !bytes.Equal(a.Raw, b.Raw) {
				t.Fatalf("seed %d: unknown field %d changed: %+v -> %+v", seed, i, a, b)
			}
		}

		got, err := parsed.GetVarints(known)
		if err != nil {
			t.Fatalf("seed %d: GetVarints: %v", seed, err)
		}
		if len(got) != len(newVals) {
			t.Fatalf("seed %d: expected %d values, got %d", seed, len(newVals), len(got))
		}
		for i, v := range newVals {
			if got[i] != v {
				t.Fatalf("seed %d: value %d: got %d want %d", seed, i, got[i], v)
			}
		}
	}
}

func filterOut(fields []scannedField, num int) []scannedField {
	var out []scannedField
	for _, f := range fields {
		if f.Number != num {
			out = append(out, f)
		}
	}
	return out
}

func TestIllegalWireTypeReportsOffset(t *testing.T) {
	// field 1 varint (2 bytes), then a tag with wire type 3 at offset 2.
	data := []byte{0x08, 0x96, 0x01, 0x0b, 0x00}
	_, err := Parse(data)
	var pe *ParseError
	if !errors.As(err, &pe) {
		t.Fatalf("expected ParseError, got %v", err)
	}
	if pe.Offset != 3 {
		t.Fatalf("offset: got %d want 3", pe.Offset)
	}

	for _, wt := range []byte{3, 4, 6, 7} {
		bad := []byte{1<<3 | wt}
		if _, err := Parse(bad); err == nil {
			t.Fatalf("wire type %d: expected error", wt)
		} else {
			var pe *ParseError
			if !errors.As(err, &pe) || pe.Offset != 0 {
				t.Fatalf("wire type %d: bad error %v", wt, err)
			}
		}
	}
}

func TestTruncationReportsOffset(t *testing.T) {
	cases := []struct {
		data   []byte
		offset int
	}{
		{[]byte{0x08}, 1},                   // tag ok, varint value missing
		{[]byte{0x09, 0x01, 0x02}, 1},       // fixed64 truncated
		{[]byte{0x0a, 0x05, 0x01}, 2},       // bytes content truncated
		{[]byte{0x0d, 0x01}, 1},             // fixed32 truncated
		{[]byte{0x80}, 0},                   // truncated tag
		{[]byte{0x08, 0x01, 0x0a, 0x03}, 4}, // second field content missing
	}
	for i, c := range cases {
		_, err := Parse(c.data)
		var pe *ParseError
		if !errors.As(err, &pe) {
			t.Fatalf("case %d: expected ParseError, got %v", i, err)
		}
		if pe.Offset != c.offset {
			t.Fatalf("case %d: offset got %d want %d", i, pe.Offset, c.offset)
		}
	}
}

func TestRepeatedAndNested(t *testing.T) {
	sub := New()
	sub.SetVarint(1, 42)
	sub.SetBytes(2, []byte("hello"))

	m := New()
	m.SetVarints(1, 7, 8, 9) // repeated
	m.SetMessage(2, sub, sub)

	data := m.Marshal()
	parsed, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}

	vs, err := parsed.GetVarints(1)
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(vs) != "[7 8 9]" {
		t.Fatalf("repeated varints: %v", vs)
	}

	subs := parsed.GetBytes(2)
	if len(subs) != 2 {
		t.Fatalf("expected 2 nested messages, got %d", len(subs))
	}
	for _, raw := range subs {
		sm, err := Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		v, ok, err := sm.GetVarint(1)
		if err != nil || !ok || v != 42 {
			t.Fatalf("nested varint: v=%d ok=%v err=%v", v, ok, err)
		}
		if got := sm.GetBytes(2); len(got) != 1 || string(got[0]) != "hello" {
			t.Fatalf("nested bytes: %q", got)
		}
	}
}

func TestNonCanonicalVarintPreserved(t *testing.T) {
	// 0x80 0x00 is a legal but non-canonical encoding of 0; unknown fields
	// must be re-emitted byte-identically.
	data := []byte{0x08, 0x80, 0x00}
	m, err := Parse(data)
	if err != nil {
		t.Fatal(err)
	}
	if got := m.Marshal(); !bytes.Equal(got, data) {
		t.Fatalf("non-canonical varint not preserved: %x", got)
	}
	v, err := m.All()[0].Value()
	if err != nil || v != 0 {
		t.Fatalf("value: %d, %v", v, err)
	}
}

func TestFieldNumberZeroRejected(t *testing.T) {
	if _, err := Parse([]byte{0x00, 0x01}); err == nil {
		t.Fatal("expected error for field number 0")
	}
}

func BenchmarkMarshalParse(b *testing.B) {
	r := rand.New(rand.NewSource(1))
	m := randomMessage(r, 0)
	data := m.Marshal()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		pm, err := Parse(data)
		if err != nil {
			b.Fatal(err)
		}
		_ = pm.Marshal()
	}
}
