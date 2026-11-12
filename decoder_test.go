package dataeng_test

import (
	"bytes"
	"errors"
	"math"
	"testing"

	de "example.org/dataeng/q0320"
	"example.org/dataeng/q0320/internal/s8fixture"
)

func TestMixedScenarioValuesAndSources(t *testing.T) {
	cfg, data, locs := mixedScenario(t)
	rows, err := de.DecodeAll(data, cfg)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("got %d rows, want 3", len(rows))
	}
	if got, ok := rows[0].Get("id"); !ok || got.Bits != 0x8000000000000000 {
		t.Fatalf("Row.Get(id) = %#v, %t", got, ok)
	}

	row0 := rows[0]
	if len(row0.Values) != 4 {
		t.Fatalf("row 0 has %d values", len(row0.Values))
	}
	id := row0.Values[0]
	if id.Field != "id" || id.Kind != de.Numeric || id.Missing {
		t.Fatalf("row 0 id = %#v", id)
	}
	if id.Bits != 0x8000000000000000 {
		t.Fatalf("negative zero bits = %#x", id.Bits)
	}
	if want := (de.Source{GroupOffset: 0, CodeIndex: 0, LiteralOffset: 8, LiteralLength: 8}); id.Source != want {
		t.Fatalf("row 0 id source = %#v, want %#v", id.Source, want)
	}
	if id.Source != (de.Source{
		GroupOffset:   locs[0].GroupOffset,
		CodeIndex:     locs[0].CodeIndex,
		LiteralOffset: locs[0].LiteralOffset,
		LiteralLength: locs[0].LiteralLength,
	}) {
		t.Fatal("id source does not match encoder layout")
	}

	name := row0.Values[1]
	wantName := []byte{0x00, 0xff, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'}
	if name.Kind != de.Bytes || !bytes.Equal(name.Data, wantName) {
		t.Fatalf("row 0 name = %q, want %q", name.Data, wantName)
	}
	if len(name.Fragments) != 2 {
		t.Fatalf("row 0 name fragments = %d, want 2", len(name.Fragments))
	}
	if !bytes.Equal(name.Fragments[0].Data, wantName[:8]) {
		t.Fatalf("fragment 0 = %q", name.Fragments[0].Data)
	}
	if !bytes.Equal(name.Fragments[1].Data, wantName[8:]) {
		t.Fatalf("fragment 1 = %q", name.Fragments[1].Data)
	}
	if name.Fragments[1].Source.LiteralLength != 8 {
		t.Fatalf("final slot literal length = %d", name.Fragments[1].Source.LiteralLength)
	}

	score := row0.Values[2]
	if score.Missing || score.Bits != 0x7ff8000000000001 {
		t.Fatalf("row 0 score = %#v", score)
	}

	note := row0.Values[3]
	if !bytes.Equal(note.Data, []byte("   ")) {
		t.Fatalf("row 0 note = %q", note.Data)
	}
	if note.Fragments[0].Source.LiteralOffset != de.NoLiteralOffset {
		t.Fatalf("opcode 254 should not have a literal: %#v", note.Fragments[0].Source)
	}

	row1 := rows[1]
	if row1.Values[0].Bits != math.Float64bits(42) {
		t.Fatalf("row 1 id = %#x", row1.Values[0].Bits)
	}
	// Row 1 completes at group-1 opcode index 4 and row 2 starts at index 5,
	// so this group spans a row boundary.
	if row1.Values[0].Source.GroupOffset != 0 || row1.Values[0].Source.CodeIndex != 5 {
		t.Fatalf("row 2 start source = %#v", row1.Values[0].Source)
	}
	if !bytes.Equal(row1.Values[1].Data, []byte("hello     ")) {
		t.Fatalf("row 1 name = %q", row1.Values[1].Data)
	}
	if !row1.Values[2].Missing || row1.Values[2].Bits != 0xffefffffffffffff {
		t.Fatalf("row 1 score = %#v", row1.Values[2])
	}

	row2 := rows[2]
	if row2.Values[0].Bits != math.Float64bits(-5) {
		t.Fatalf("row 2 id = %#x", row2.Values[0].Bits)
	}
	missing := row2.Values[2]
	if !missing.Missing || missing.Bits != 0xffefffffffffffff {
		t.Fatalf("row 2 system missing = %#v", missing)
	}
	if want := []byte{0x00, 0xff, 'Z'}; !bytes.Equal(row2.Values[3].Data, want) {
		t.Fatalf("row 2 note = %q, want %q", row2.Values[3].Data, want)
	}

	// The final row's note slot has opcode index 6 in group 2 while the
	// terminator is opcode index 7 of that same group. Its literal is
	// physically after the complete eight-byte header, including 252.
	lastNote := row2.Values[3].Fragments[0].Source
	terminator := locs[15]
	if lastNote.LiteralOffset <= terminator.GroupOffset+int64(terminator.CodeIndex) {
		t.Fatalf("last literal %#v is not after terminator code at %d",
			lastNote, terminator.GroupOffset+int64(terminator.CodeIndex))
	}
}

func TestMultipleLiteralSlotsInOneGroup(t *testing.T) {
	_, _, locs := mixedScenario(t)
	// Row 1 contains four opcode-253 slots at group-1 code indexes 0..3,
	// followed by opcode 254. Their literals must be 8, 16, 24, and 32.
	for i, want := range []int64{8, 16, 24, 32} {
		if locs[i].GroupOffset != 0 || locs[i].CodeIndex != i || locs[i].LiteralOffset != want {
			t.Fatalf("slot %d location = %#v, want literal %d", i, locs[i], want)
		}
	}
}

func TestLongBytesAcrossGroups(t *testing.T) {
	cfg, data, locs := longBytesScenario(t)
	rows, err := decodeWithCuts(t, cfg, data, nil)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows", len(rows))
	}
	blob := rows[0].Values[1]
	if len(blob.Data) != 160 || len(blob.Fragments) != 20 {
		t.Fatalf("blob len=%d fragments=%d", len(blob.Data), len(blob.Fragments))
	}
	if blob.Data[0] != 0x00 || blob.Data[1] != 0xff {
		t.Fatalf("blob prefix = %#x", blob.Data[:2])
	}
	groups := map[int64]bool{}
	for _, f := range blob.Fragments {
		groups[f.Source.GroupOffset] = true
	}
	if len(groups) < 3 {
		t.Fatalf("blob spans only %d groups, want at least 3", len(groups))
	}
	for i, frag := range blob.Fragments {
		want := locs[i+1] // locs[0] is the numeric field
		if frag.Source.GroupOffset != want.GroupOffset ||
			frag.Source.CodeIndex != want.CodeIndex ||
			frag.Source.LiteralOffset != want.LiteralOffset ||
			frag.Source.LiteralLength != want.LiteralLength {
			t.Fatalf("fragment %d source = %#v, encoder location = %#v", i, frag.Source, want)
		}
	}
}

func TestLastLiteralAfterTerminator(t *testing.T) {
	cfg, data, locs := lastLiteralScenario(t)
	rows, err := decodeWithCuts(t, cfg, data, nil)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rows) != 1 || rows[0].Values[0].Bits != 0x3ff0000000000000 {
		t.Fatalf("rows = %#v", rows)
	}
	src := rows[0].Values[0].Source
	if src.LiteralOffset != 8 || src.LiteralLength != 8 {
		t.Fatalf("source = %#v", src)
	}
	if locs[1].CodeIndex != 1 || locs[1].GroupOffset != 0 {
		t.Fatalf("terminator location = %#v", locs[1])
	}
	if src.LiteralOffset <= locs[1].GroupOffset+int64(locs[1].CodeIndex) {
		t.Fatal("literal is not physically after the 252 opcode byte")
	}
}

func TestZeroPaddingDoesNotConsumeFieldsOrAddSources(t *testing.T) {
	cfg, data, locs := paddingScenario(t)
	rows, err := decodeWithCuts(t, cfg, data, nil)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows", len(rows))
	}
	n := rows[0].Values[0]
	if n.Bits != math.Float64bits(7) {
		t.Fatalf("numeric = %#x", n.Bits)
	}
	if n.Source.CodeIndex != 1 || n.Source.LiteralOffset != de.NoLiteralOffset {
		t.Fatalf("numeric source = %#v", n.Source)
	}
	b := rows[0].Values[1]
	if !bytes.Equal(b.Data, []byte{0x00, 0xff, 'p', 'a', 'd', 'd', 'e', 'd'}) {
		t.Fatalf("bytes = %#v", b.Data)
	}
	if len(b.Fragments) != 1 {
		t.Fatalf("fragments = %d", len(b.Fragments))
	}
	if b.Source != b.Fragments[0].Source {
		t.Fatalf("bytes Source = %#v, first fragment = %#v", b.Source, b.Fragments[0].Source)
	}
	if b.Fragments[0].Source.CodeIndex != 3 || b.Fragments[0].Source.LiteralOffset != 8 {
		t.Fatalf("bytes source = %#v", b.Fragments[0].Source)
	}
	if want := locs[3].LiteralOffset; b.Fragments[0].Source.LiteralOffset != want {
		t.Fatalf("literal offset = %d, want %d", b.Fragments[0].Source.LiteralOffset, want)
	}
}

func TestProjectionOrderAndSelection(t *testing.T) {
	cfg, data, _ := mixedScenario(t)
	cfg.Projection = []string{"note", "id"}
	rows, err := decodeWithCuts(t, cfg, data, nil)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("got %d rows", len(rows))
	}
	for i, row := range rows {
		if len(row.Values) != 2 {
			t.Fatalf("row %d has %d values", i, len(row.Values))
		}
		if row.Values[0].Field != "note" || row.Values[1].Field != "id" {
			t.Fatalf("row %d projection order = %q, %q", i, row.Values[0].Field, row.Values[1].Field)
		}
	}
}

func TestUnprojectedBytesBadPaddingStillFails(t *testing.T) {
	cfg := de.Config{
		Fields: []de.Field{
			de.NumericField("keep"),
			de.BytesField("hidden", 10),
		},
		NumericEndian: de.LittleEndian,
		Bias:          100,
		MaxRows:       5,
		RowByteBudget: 32,
		Projection:    []string{"keep"},
	}

	b := s8fixture.New(s8fixture.Little)
	add(t, b.AddCode(1, cfg.Bias))
	add(t, b.AddBytesLiteral([8]byte{'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'}))
	add(t, b.AddBytesLiteral([8]byte{'i', 'j', 'X', ' ', ' ', ' ', ' ', ' '}))
	add(t, b.AddTerminator())
	data, _, err := b.Encode()
	add(t, err)

	d, err := de.NewDecoder(cfg)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	rows, err := d.Push(data)
	if err == nil {
		t.Fatal("expected bad padding error")
	}
	if !errors.Is(err, de.ErrBadPadding) {
		t.Fatalf("error = %v, want bad padding", err)
	}
	if len(rows) != 0 {
		t.Fatalf("delivered %d rows despite padding error", len(rows))
	}
}

func TestBigEndianLiteralBits(t *testing.T) {
	cfg := de.Config{
		Fields:        []de.Field{de.NumericField("n")},
		NumericEndian: de.BigEndian,
		Bias:          1000,
		MaxRows:       5,
		RowByteBudget: 8,
	}
	b := s8fixture.New(s8fixture.Big)
	add(t, b.AddNumericLiteral(0x8000000000000000))
	add(t, b.AddNumericLiteral(0x7ff8000000000001))
	add(t, b.AddNumericLiteral(0xffefffffffffffff))
	add(t, b.AddTerminator())
	data, _, err := b.Encode()
	add(t, err)

	rows, err := decodeWithCuts(t, cfg, data, nil)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("got %d rows", len(rows))
	}
	if rows[0].Values[0].Bits != 0x8000000000000000 {
		t.Fatalf("negative zero = %#x", rows[0].Values[0].Bits)
	}
	if rows[1].Values[0].Bits != 0x7ff8000000000001 {
		t.Fatalf("NaN = %#x", rows[1].Values[0].Bits)
	}
	if !rows[2].Values[0].Missing || rows[2].Values[0].Bits != 0xffefffffffffffff {
		t.Fatalf("system missing = %#v", rows[2].Values[0])
	}
}

func TestAllChunkingsAgainstReference(t *testing.T) {
	scenarios := []struct {
		name  string
		build func(*testing.T) (de.Config, []byte, []s8fixture.Location)
	}{
		{"mixed", mixedScenario},
		{"long-bytes", longBytesScenario},
		{"last-literal", lastLiteralScenario},
		{"padding", paddingScenario},
	}
	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			cfg, data, _ := sc.build(t)
			checkAllChunkings(t, cfg, data)
		})
	}
}

func TestTruncationAtEveryByte(t *testing.T) {
	scenarios := []struct {
		name  string
		build func(*testing.T) (de.Config, []byte, []s8fixture.Location)
	}{
		{"mixed", mixedScenario},
		{"long-bytes", longBytesScenario},
		{"last-literal", lastLiteralScenario},
	}
	for _, sc := range scenarios {
		t.Run(sc.name, func(t *testing.T) {
			cfg, data, _ := sc.build(t)
			checkTruncationAtEveryByte(t, cfg, data)
		})
	}
}

func TestNoTerminatorAtCompleteRowBoundaryIsTruncated(t *testing.T) {
	cfg := de.Config{
		Fields:        []de.Field{de.NumericField("n")},
		NumericEndian: de.LittleEndian,
		Bias:          0,
		MaxRows:       20,
		RowByteBudget: 8,
	}
	b := s8fixture.New(s8fixture.Little)
	for i := 0; i < 8; i++ {
		add(t, b.AddCode(i+1, cfg.Bias))
	}
	data, _, err := b.Encode()
	add(t, err)
	if len(data) != 8 {
		t.Fatalf("data length = %d, want 8", len(data))
	}

	d, err := de.NewDecoder(cfg)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	rows, err := d.Push(data)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if len(rows) != 8 {
		t.Fatalf("got %d rows, want 8", len(rows))
	}
	if err := d.Finish(); !errors.Is(err, de.ErrTruncated) {
		t.Fatalf("Finish = %v, want truncated", err)
	}
}

func TestIncompleteCurrentRowNotDelivered(t *testing.T) {
	cfg := de.Config{
		Fields: []de.Field{
			de.NumericField("n"),
			de.BytesField("b", 8),
		},
		NumericEndian: de.LittleEndian,
		Bias:          100,
		MaxRows:       5,
		RowByteBudget: 8,
	}
	b := s8fixture.New(s8fixture.Little)
	add(t, b.AddCode(1, cfg.Bias))
	add(t, b.AddBytesLiteral([8]byte{'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'}))
	add(t, b.AddCode(2, cfg.Bias))
	add(t, b.AddTerminator())
	data, _, err := b.Encode()
	add(t, err)

	d, err := de.NewDecoder(cfg)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	rows, pushErr := d.Push(data)
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want only complete row", len(rows))
	}
	// The second row is incomplete, so 252 is not at a row boundary.
	if !errors.Is(pushErr, de.ErrRowBoundary) {
		t.Fatalf("Push error = %v, want row boundary", pushErr)
	}
	if rows[0].Values[0].Bits != math.Float64bits(1) {
		t.Fatalf("row bits = %#x", rows[0].Values[0].Bits)
	}
}

func TestIncompleteTailAtEOFIsNotDelivered(t *testing.T) {
	cfg := de.Config{
		Fields: []de.Field{
			de.NumericField("n"),
			de.BytesField("b", 8),
		},
		NumericEndian: de.LittleEndian,
		Bias:          100,
		MaxRows:       5,
		RowByteBudget: 8,
	}
	b := s8fixture.New(s8fixture.Little)
	add(t, b.AddCode(1, cfg.Bias))
	add(t, b.AddBytesLiteral([8]byte{'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'}))
	add(t, b.AddCode(2, cfg.Bias))
	// No terminator and no bytes slot for the second row.
	data, _, err := b.Encode()
	add(t, err)

	d, err := de.NewDecoder(cfg)
	if err != nil {
		t.Fatalf("NewDecoder: %v", err)
	}
	rows, err := d.Push(data)
	if err != nil {
		t.Fatalf("Push: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("got %d rows, want only the completed row", len(rows))
	}
	if err := d.Finish(); !errors.Is(err, de.ErrTruncated) {
		t.Fatalf("Finish = %v, want truncated", err)
	}
}
