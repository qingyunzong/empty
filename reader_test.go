package dataeng

import (
	"bytes"
	"io"
	"testing"
)

// chunkReader delivers the stream in small blocks to exercise reassembly of
// records that span block boundaries.
type chunkReader struct {
	data []byte
	n    int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if len(c.data) == 0 {
		return 0, io.EOF
	}
	n := c.n
	if n > len(c.data) {
		n = len(c.data)
	}
	copy(p, c.data[:n])
	c.data = c.data[n:]
	return n, nil
}

func registryWith(t *testing.T, schemas ...*Schema) *Registry {
	t.Helper()
	reg := NewRegistry()
	for _, s := range schemas {
		if err := reg.Register(s); err != nil {
			t.Fatal(err)
		}
	}
	return reg
}

func TestSchemaSelection(t *testing.T) {
	v1 := testSchema()
	v2 := &Schema{
		Name:         "acct",
		Version:      "02",
		RecordLength: 18,
		CodePage:     CP037,
		Discriminator: &Discriminator{
			Offset: 0,
			Length: 2,
			Values: []string{"02"},
		},
		Fields: []Field{{Name: "VER", Offset: 0, Length: 2, Type: FieldString}},
	}
	long := &Schema{
		Name:         "other",
		RecordLength: 20,
		CodePage:     CP037,
		Fields:       []Field{{Name: "X", Offset: 0, Length: 20, Type: FieldString}},
	}
	latin1 := &Schema{
		Name:         "acct1047",
		Version:      "01",
		RecordLength: 18,
		CodePage:     CP1047,
		Discriminator: &Discriminator{
			Offset: 0,
			Length: 2,
			Values: []string{"01"},
		},
		Fields: []Field{{Name: "VER", Offset: 0, Length: 2, Type: FieldString}},
	}
	reg := registryWith(t, v1, v2, long, latin1)

	rec1 := buildRecord(t, "01", "A", []byte{0x00, 0x00, 0x00, 0x1C}, []byte{0xF0, 0xF0, 0xF0, 0xF0})
	s, err := reg.Match(rec1, CP037)
	if err != nil || s.Version != "01" {
		t.Fatalf("match v1: %v, %v", s, err)
	}

	rec2 := buildRecord(t, "02", "A", []byte{0x00, 0x00, 0x00, 0x1C}, []byte{0xF0, 0xF0, 0xF0, 0xF0})
	s, err = reg.Match(rec2, CP037)
	if err != nil || s.Version != "02" {
		t.Fatalf("match v2: %v, %v", s, err)
	}

	s, err = reg.Match(make([]byte, 20), CP037)
	if err != nil || s.Name != "other" {
		t.Fatalf("match by length: %v, %v", s, err)
	}

	s, err = reg.Match(rec1, CP1047)
	if err != nil || s.Name != "acct1047" {
		t.Fatalf("match by code page: %v, %v", s, err)
	}

	if _, err := reg.Match(make([]byte, 7), CP037); err == nil {
		t.Fatal("expected no-match error")
	}
}

func TestReaderCrossBlockAndOffsets(t *testing.T) {
	reg := registryWith(t, testSchema())
	good1 := buildRecord(t, "01", "ALICE", []byte{0x00, 0x12, 0x34, 0x5C}, []byte{0xF0, 0xF0, 0xF1, 0xF0})
	bad := buildRecord(t, "01", "MALLORY", []byte{0xFF, 0xFF, 0xFF, 0xFF}, []byte{0xF0, 0xF0, 0xF0, 0xF0})
	good2 := buildRecord(t, "01", "CAROL", []byte{0x00, 0x00, 0x00, 0x1D}, []byte{0xF9, 0xF9, 0xF9, 0xD9})

	stream := append(append(append([]byte{}, good1...), bad...), good2...)
	// 5-byte blocks deliberately misaligned with the 18-byte frame.
	r, err := NewReader(&chunkReader{data: stream, n: 5}, reg, CP037, 18)
	if err != nil {
		t.Fatal(err)
	}
	good, badRecs, err := r.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(good) != 2 || len(badRecs) != 1 {
		t.Fatalf("good=%d bad=%d", len(good), len(badRecs))
	}
	if good[0].Offset != 0 || good[1].Offset != 36 {
		t.Fatalf("good offsets: %d, %d", good[0].Offset, good[1].Offset)
	}
	if badRecs[0].Offset != 18 {
		t.Fatalf("bad offset: %d", badRecs[0].Offset)
	}
	if !bytes.Equal(badRecs[0].Raw, bad) {
		t.Fatal("bad record raw bytes not preserved")
	}
	if len(badRecs[0].Errs) == 0 {
		t.Fatal("bad record carries no error")
	}
	if got := good[0].Values["AMT"]; got != (Decimal{12345, 2}) {
		t.Fatalf("AMT: %v", got)
	}
	if got := good[1].Values["QTY"]; got != (Decimal{-9999, 0}) {
		t.Fatalf("QTY: %v", got)
	}
	if got := good[1].Values["NAME"]; got != "CAROL" {
		t.Fatalf("NAME: %v", got)
	}
}

func TestReaderFramingIsByteBased(t *testing.T) {
	// 0x4A decodes to '¢' (U+00A2), a two-byte UTF-8 rune. Framing must stay
	// byte-count based so the following record keeps its offset.
	reg := registryWith(t, testSchema())
	rec1 := buildRecord(t, "01", "A", []byte{0x00, 0x00, 0x00, 0x1C}, []byte{0xF0, 0xF0, 0xF0, 0xF0})
	rec1[2] = 0x4A // '¢' in the NAME field
	rec2 := buildRecord(t, "01", "Z", []byte{0x00, 0x00, 0x00, 0x1C}, []byte{0xF0, 0xF0, 0xF0, 0xF0})
	stream := append(append([]byte{}, rec1...), rec2...)

	r, err := NewReader(&chunkReader{data: stream, n: 7}, reg, CP037, 18)
	if err != nil {
		t.Fatal(err)
	}
	good, badRecs, err := r.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(badRecs) != 0 || len(good) != 2 {
		t.Fatalf("good=%d bad=%d", len(good), len(badRecs))
	}
	if good[1].Offset != 18 {
		t.Fatalf("second record offset: %d", good[1].Offset)
	}
	name, ok := good[0].Values["NAME"].(string)
	if !ok || name != "¢" {
		t.Fatalf("NAME: %q", name)
	}
}

func TestReaderTruncatedTail(t *testing.T) {
	reg := registryWith(t, testSchema())
	rec := buildRecord(t, "01", "BOB", []byte{0x00, 0x00, 0x00, 0x1C}, []byte{0xF0, 0xF0, 0xF0, 0xF0})
	stream := append(append([]byte{}, rec...), rec[:7]...) // trailing partial record

	r, err := NewReader(bytes.NewReader(stream), reg, CP037, 18)
	if err != nil {
		t.Fatal(err)
	}
	good, badRecs, err := r.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(good) != 1 || len(badRecs) != 1 {
		t.Fatalf("good=%d bad=%d", len(good), len(badRecs))
	}
	if badRecs[0].Offset != 18 || len(badRecs[0].Raw) != 7 {
		t.Fatalf("truncated record: offset=%d len=%d", badRecs[0].Offset, len(badRecs[0].Raw))
	}
}

func TestReaderUnknownSchemaIsolated(t *testing.T) {
	reg := registryWith(t, testSchema())
	unknown := buildRecord(t, "99", "X", []byte{0x00, 0x00, 0x00, 0x1C}, []byte{0xF0, 0xF0, 0xF0, 0xF0})
	r, err := NewReader(bytes.NewReader(unknown), reg, CP037, 18)
	if err != nil {
		t.Fatal(err)
	}
	good, badRecs, err := r.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(good) != 0 || len(badRecs) != 1 || badRecs[0].Offset != 0 {
		t.Fatalf("good=%d bad=%v", len(good), badRecs)
	}
}
