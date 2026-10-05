package binmsg

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"math/rand/v2"
	"strings"
	"testing"
)

// genMessage builds a random encoded message plus a schema covering a random
// subset of its fields. depth limits nested-message recursion.
func genMessage(r *rand.Rand, depth int) ([]byte, Schema) {
	schema := Schema{}
	var buf []byte
	n := 1 + r.IntN(12)
	for i := 0; i < n; i++ {
		num := 1 + r.IntN(20)
		wt := []WireType{WireVarint, WireFixed64, WireBytes, WireFixed32}[r.IntN(4)]
		// Randomly register the field in the schema; the rest stay unknown.
		if r.IntN(2) == 0 {
			schema[num] = wt
		}
		buf = appendVarint(buf, uint64(num)<<3|uint64(wt))
		switch wt {
		case WireVarint:
			buf = appendVarint(buf, r.Uint64())
		case WireFixed64:
			var b [8]byte
			binary.LittleEndian.PutUint64(b[:], r.Uint64())
			buf = append(buf, b[:]...)
		case WireBytes:
			var payload []byte
			if depth < 2 && r.IntN(3) == 0 {
				sub, subSchema := genMessage(r, depth+1)
				// Register the nested field as WireBytes; nested content is
				// parsed on demand via Nested with subSchema.
				_ = subSchema
				payload = sub
			} else {
				payload = make([]byte, r.IntN(24))
				r.Uint64() // advance state
				for j := range payload {
					payload[j] = byte(r.IntN(256))
				}
			}
			buf = appendVarint(buf, uint64(len(payload)))
			buf = append(buf, payload...)
		case WireFixed32:
			var b [4]byte
			binary.LittleEndian.PutUint32(b[:], r.Uint32())
			buf = append(buf, b[:]...)
		}
	}
	return buf, schema
}

// unknownSeq extracts the sequence of unknown fields (number, wire, raw
// bytes) from data using the independent scanner.
func unknownSeq(t *testing.T, data []byte, schema Schema) []RawField {
	t.Helper()
	rfs, err := Scan(data)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	var out []RawField
	for _, rf := range rfs {
		if wt, ok := schema[rf.Number]; ok && wt == rf.Wire {
			continue
		}
		out = append(out, rf)
	}
	return out
}

func TestRoundTripRandom(t *testing.T) {
	for seed := uint64(0); seed < 300; seed++ {
		r := rand.New(rand.NewPCG(seed, seed^0x9e3779b9))
		data, schema := genMessage(r, 0)
		m, err := Parse(data, schema)
		if err != nil {
			t.Fatalf("seed %d: Parse: %v", seed, err)
		}
		got := m.Marshal()
		if !bytes.Equal(got, data) {
			t.Fatalf("seed %d: round trip mismatch\n got %x\nwant %x", seed, got, data)
		}
	}
}

func TestCrossCheckScanner(t *testing.T) {
	for seed := uint64(0); seed < 300; seed++ {
		r := rand.New(rand.NewPCG(seed, 0xdeadbeef+seed))
		data, schema := genMessage(r, 0)
		m, err := Parse(data, schema)
		if err != nil {
			t.Fatalf("seed %d: Parse: %v", seed, err)
		}
		rfs, err := Scan(data)
		if err != nil {
			t.Fatalf("seed %d: Scan: %v", seed, err)
		}
		if len(m.Fields) != len(rfs) {
			t.Fatalf("seed %d: field count %d != scanner count %d", seed, len(m.Fields), len(rfs))
		}
		for i, f := range m.Fields {
			rf := rfs[i]
			if f.Number != rf.Number || f.Wire != rf.Wire {
				t.Fatalf("seed %d field %d: parse (%d,%d) vs scan (%d,%d)",
					seed, i, f.Number, f.Wire, rf.Number, rf.Wire)
			}
			if !f.Known && !bytes.Equal(f.Raw, rf.Raw) {
				t.Fatalf("seed %d field %d: unknown raw mismatch", seed, i)
			}
		}
	}
}

func TestModifyPreservesUnknownOrder(t *testing.T) {
	for seed := uint64(0); seed < 300; seed++ {
		r := rand.New(rand.NewPCG(seed, 0xcafebabe+seed))
		data, schema := genMessage(r, 0)
		if len(schema) == 0 {
			schema[1] = WireVarint // ensure there is a known field to edit
		}
		before := unknownSeq(t, data, schema)

		m, err := Parse(data, schema)
		if err != nil {
			t.Fatalf("seed %d: Parse: %v", seed, err)
		}
		// Modify known fields: overwrite, add repeated values, add new field.
		for num, wt := range schema {
			var v1, v2 any
			switch wt {
			case WireVarint, WireFixed64:
				v1, v2 = r.Uint64(), r.Uint64()
			case WireFixed32:
				v1, v2 = r.Uint32(), r.Uint32()
			case WireBytes:
				v1, v2 = []byte{0xde, 0xad}, []byte{0xbe, 0xef}
			}
			m.Set(num, wt, v1)
			m.Append(num, wt, v2) // repeated value
			break                 // one edit per seed is enough; schema map order is random
		}
		m.Set(99, WireVarint, uint64(12345)) // brand-new known field

		// The after-schema also knows the fields we just set.
		afterSchema := Schema{99: WireVarint}
		for num, wt := range schema {
			afterSchema[num] = wt
		}
		out := m.Marshal()
		after := unknownSeq(t, out, afterSchema)
		if len(before) != len(after) {
			t.Fatalf("seed %d: unknown count %d -> %d", seed, len(before), len(after))
		}
		for i := range before {
			if before[i].Number != after[i].Number || before[i].Wire != after[i].Wire ||
				!bytes.Equal(before[i].Raw, after[i].Raw) {
				t.Fatalf("seed %d: unknown field %d changed: (%d,%d,%x) -> (%d,%d,%x)",
					seed, i, before[i].Number, before[i].Wire, before[i].Raw,
					after[i].Number, after[i].Wire, after[i].Raw)
			}
		}
		// The modified message must still parse and reflect the edit.
		m2, err := Parse(out, afterSchema)
		if err != nil {
			t.Fatalf("seed %d: re-Parse: %v", seed, err)
		}
		if v, ok := m2.Get(99); !ok || v.(uint64) != 12345 {
			t.Fatalf("seed %d: new field not reflected: %v %v", seed, v, ok)
		}
	}
}

func TestInvalidWireTypeOffset(t *testing.T) {
	for _, wt := range []byte{3, 4, 6, 7} {
		// Prefix with one valid varint field (field 1 = 0) so the bad tag is
		// at a non-zero offset.
		data := []byte{0x08, 0x00, 5<<3 | wt, 0x00}
		_, err := Parse(data, nil)
		if err == nil {
			t.Fatalf("wire type %d: expected error", wt)
		}
		off, ok := ErrorOffset(err)
		if !ok || off != 2 {
			t.Fatalf("wire type %d: offset = %d, %v; want 2", wt, off, ok)
		}
		if !strings.Contains(err.Error(), fmt.Sprintf("wire type %d", wt)) {
			t.Fatalf("error %q does not name wire type %d", err, wt)
		}
		// The independent scanner must agree.
		if _, serr := Scan(data); serr == nil {
			t.Fatalf("wire type %d: scanner expected error", wt)
		} else if soff, _ := ErrorOffset(serr); soff != 2 {
			t.Fatalf("wire type %d: scanner offset = %d; want 2", wt, soff)
		}
	}
}

func TestTruncatedInputs(t *testing.T) {
	cases := []struct {
		name string
		data []byte
	}{
		{"truncated tag varint", []byte{0x80}},
		{"truncated value varint", []byte{0x08, 0x80}},
		{"truncated fixed64", []byte{0x09, 0x01, 0x02}},
		{"truncated fixed32", []byte{0x0d, 0x01}},
		{"truncated length", []byte{0x0a}},
		{"length overruns input", []byte{0x0a, 0x05, 0x01}},
		{"field number zero", []byte{0x00, 0x00}},
	}
	for _, tc := range cases {
		if _, err := Parse(tc.data, nil); err == nil {
			t.Fatalf("%s: expected error", tc.name)
		} else if _, ok := ErrorOffset(err); !ok {
			t.Fatalf("%s: error %v carries no offset", tc.name, err)
		}
		if _, err := Scan(tc.data); err == nil {
			t.Fatalf("%s: scanner expected error", tc.name)
		}
	}
}

func TestNestedAndRepeated(t *testing.T) {
	subSchema := Schema{1: WireVarint, 2: WireBytes}
	sub := &Message{}
	sub.Append(1, WireVarint, 42)
	sub.Append(2, WireBytes, []byte("hello"))
	sub.Append(1, WireVarint, 43) // repeated

	topSchema := Schema{1: WireVarint, 5: WireBytes}
	top := &Message{}
	top.Append(1, WireVarint, 7)
	top.Append(5, WireBytes, sub.Marshal())

	data := top.Marshal()
	got, err := Parse(data, topSchema)
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if v, _ := got.Get(1); v.(uint64) != 7 {
		t.Fatalf("field 1 = %v", v)
	}
	nested, err := got.Nested(5, subSchema)
	if err != nil {
		t.Fatalf("Nested: %v", err)
	}
	vals := nested.Values(1)
	if len(vals) != 2 || vals[0].(uint64) != 42 || vals[1].(uint64) != 43 {
		t.Fatalf("repeated values = %v", vals)
	}
	if v, _ := nested.Get(2); string(v.([]byte)) != "hello" {
		t.Fatalf("nested field 2 = %v", v)
	}
	// Round trip the whole structure.
	if !bytes.Equal(got.Marshal(), data) {
		t.Fatalf("nested round trip mismatch")
	}
}

func TestUnknownNonCanonicalTagPreserved(t *testing.T) {
	// Overlong (non-canonical) varint encoding of tag 0x10: field 2, varint.
	data := []byte{0x90, 0x00, 0x2a}
	m, err := Parse(data, Schema{}) // nothing known
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if !bytes.Equal(m.Marshal(), data) {
		t.Fatalf("non-canonical unknown tag not preserved: %x", m.Marshal())
	}
}
