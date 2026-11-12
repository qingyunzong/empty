package dataeng

import (
	"encoding/binary"
	"errors"
	"math"
	"testing"
)

func magicBytes() []byte {
	return append([]byte(nil), Magic[:]...)
}

func fieldCount(n int16) []byte {
	b := make([]byte, 2)
	binary.BigEndian.PutUint16(b, uint16(n))
	return b
}

func lenPrefix(n int32) []byte {
	b := make([]byte, 4)
	binary.BigEndian.PutUint32(b, uint32(n))
	return b
}

func nullField() []byte { return lenPrefix(-1) }

func rawField(body []byte) []byte {
	return append(lenPrefix(int32(len(body))), body...)
}

func intField(v int64) []byte {
	b := make([]byte, 8)
	binary.BigEndian.PutUint64(b, uint64(v))
	return append(lenPrefix(8), b...)
}

func intFieldLen(length int32) []byte {
	b := make([]byte, 8)
	return append(lenPrefix(length), b...)
}

func textField(s string) []byte {
	return rawField([]byte(s))
}

func row(fields ...[]byte) []byte {
	out := fieldCount(int16(len(fields)))
	for _, f := range fields {
		out = append(out, f...)
	}
	return out
}

func terminator() []byte { return fieldCount(-1) }

func stream(parts ...[]byte) []byte {
	out := magicBytes()
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func flatten(parts [][]byte) []byte {
	var out []byte
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func feedByteByByte(t *testing.T, p *Parser, data []byte) {
	t.Helper()
	for i := 0; i < len(data); i++ {
		n, err := p.Feed(data[i : i+1])
		if n < 0 || n > 1 {
			t.Fatalf("byte %d: consumed %d outside [0,1]", i, n)
		}
		if err != nil && !errors.Is(err, ErrPaused) {
			t.Fatalf("byte %d: unexpected error %v", i, err)
		}
		if errors.Is(err, ErrPaused) {
			// On pause the current chunk must be fully consumed: the row
			// is already accepted and must never be redelivered.
			if err := p.Resume(); err != nil && !errors.Is(err, ErrPaused) {
				t.Fatalf("byte %d: resume error %v", i, err)
			}
		}
	}
	// After the final byte every buffered frame must have drained, so the
	// total consumed position equals the stream length.
	if p.base != int64(len(data)) || len(p.buf) != 0 {
		t.Fatalf("drained position %d (+%d buffered), want %d", p.base, len(p.buf), len(data))
	}
}

func assertParseErr(t *testing.T, err error, code ErrorCode, offset int64) {
	t.Helper()
	var pe *ParseError
	if !errors.As(err, &pe) {
		t.Fatalf("want *ParseError(%s,%d), got %v", code, offset, err)
	}
	if pe.Code != code || pe.Offset != offset {
		t.Fatalf("want (%s,%d), got (%s,%d)", code, offset, pe.Code, pe.Offset)
	}
}

func TestZeroColumnsByteByByte(t *testing.T) {
	data := stream(row(), row(), terminator())
	p := NewParser(Config{Columns: nil})
	feedByteByByte(t, p, data)
	if err := p.End(); err != nil {
		t.Fatalf("End: %v", err)
	}
	if got := p.Delivered(); got != 2 {
		t.Fatalf("delivered %d, want 2", got)
	}
	for _, r := range p.Rows() {
		if len(r.Fields) != 0 {
			t.Fatalf("zero-column row has %d fields", len(r.Fields))
		}
	}

	p2 := NewParser(Config{Columns: []FieldType{}})
	if n, err := p2.Feed(data); err != nil || n != len(data) {
		t.Fatalf("single Feed: n=%d err=%v", n, err)
	}
	if err := p2.End(); err != nil || p2.Delivered() != 2 {
		t.Fatalf("single-chunk result err=%v delivered=%d", err, p2.Delivered())
	}
}

func TestNullAndEmptyDistinct(t *testing.T) {
	schema := []FieldType{Raw, Text, Integer}
	data := stream(
		row(nullField(), textField(""), intField(0)),
		row(nullField(), rawField([]byte{}), intField(-7)),
		terminator(),
	)
	p := NewParser(Config{Columns: schema})
	feedByteByByte(t, p, data)
	if err := p.End(); err != nil {
		t.Fatalf("End: %v", err)
	}
	rows := p.Rows()
	if len(rows) != 2 {
		t.Fatalf("rows %d, want 2", len(rows))
	}

	first := rows[0].Fields
	if !first[0].Null || first[0].Data != nil {
		t.Fatalf("field0 want null, got %+v", first[0])
	}
	if first[1].Null || first[1].Text != "" || len(first[1].Data) != 0 {
		t.Fatalf("field1 want empty non-null text, got %+v", first[1])
	}
	if first[2].Null || first[2].Int != 0 {
		t.Fatalf("field2 want non-null int 0, got %+v", first[2])
	}

	second := rows[1].Fields
	if !second[0].Null {
		t.Fatalf("second field0 want null")
	}
	if second[1].Null || len(second[1].Data) != 0 {
		t.Fatalf("second field1 want empty non-null raw, got null=%v", second[1].Null)
	}
	if second[2].Int != -7 {
		t.Fatalf("second field2 int = %d, want -7", second[2].Int)
	}
}

func TestIntegerEndpoints(t *testing.T) {
	schema := []FieldType{Integer}
	values := []int64{0, 1, -1, math.MaxInt64, math.MinInt64, 42, -42}
	var parts [][]byte
	for _, v := range values {
		parts = append(parts, row(intField(v)))
	}
	data := stream(flatten(parts), terminator())

	p := NewParser(Config{Columns: schema})
	feedByteByByte(t, p, data)
	if err := p.End(); err != nil {
		t.Fatalf("End: %v", err)
	}
	if p.Delivered() != len(values) {
		t.Fatalf("delivered %d, want %d", p.Delivered(), len(values))
	}
	for i, r := range p.Rows() {
		f := r.Fields[0]
		if f.Null || f.Int != values[i] {
			t.Fatalf("row %d got null=%v int=%d, want %d", i, f.Null, f.Int, values[i])
		}
	}

	p2 := NewParser(Config{Columns: schema})
	d2 := stream(row(nullField()), terminator())
	if _, err := p2.Feed(d2); err != nil {
		t.Fatalf("null integer: %v", err)
	}
	if err := p2.End(); err != nil || !p2.Rows()[0].Fields[0].Null {
		t.Fatalf("null integer not delivered correctly: %v", err)
	}
}

func TestIntegerWrongLengthReportsPrefix(t *testing.T) {
	schema := []FieldType{Integer}
	// magic(4) + count(2); the length prefix therefore starts at offset 6.
	data := stream(row(intFieldLen(4)), terminator())
	p := NewParser(Config{Columns: schema})
	_, err := p.Feed(data)
	assertParseErr(t, err, ErrIntegerLength, 6)
	if p.Delivered() != 0 {
		t.Fatalf("no row may be delivered before error")
	}

	p2 := NewParser(Config{Columns: schema})
	var lastErr error
	for i := 0; i < len(data); i++ {
		_, lastErr = p2.Feed(data[i : i+1])
		if lastErr != nil {
			break
		}
	}
	assertParseErr(t, lastErr, ErrIntegerLength, 6)
}

func TestTerminatorRules(t *testing.T) {
	schema := []FieldType{Raw}

	p := NewParser(Config{Columns: schema})
	data := stream(row(rawField([]byte("ok"))), terminator())
	if _, err := p.Feed(data); err != nil {
		t.Fatalf("Feed: %v", err)
	}
	if err := p.End(); err != nil {
		t.Fatalf("End: %v", err)
	}

	// any byte after the terminator reports that byte's absolute offset
	trailing := append(stream(terminator()), 0xAB)
	p2 := NewParser(Config{Columns: schema})
	_, err := p2.Feed(trailing)
	assertParseErr(t, err, ErrBytesAfterTerminator, int64(len(trailing)-1))

	// missing terminator at End => truncation at total input length
	partial := stream(row(rawField([]byte("ok"))))
	p3 := NewParser(Config{Columns: schema})
	if _, err := p3.Feed(partial); err != nil {
		t.Fatalf("Feed partial: %v", err)
	}
	err = p3.End()
	assertParseErr(t, err, ErrTruncated, int64(len(partial)))

	// negative counts other than -1 are illegal at the prefix start
	bad := append(magicBytes(), fieldCount(-2)...)
	p4 := NewParser(Config{Columns: schema})
	_, err = p4.Feed(bad)
	assertParseErr(t, err, ErrIllegalFieldCount, 4)

	// sticky after error
	if _, err := p4.Feed(terminator()); !errors.As(err, new(*ParseError)) {
		t.Fatalf("want sticky ParseError, got %v", err)
	}
}

func TestFieldCountMismatch(t *testing.T) {
	schema := []FieldType{Raw, Raw}
	// a one-field row: count prefix starts at offset 4
	data := stream(row(rawField([]byte("x"))), terminator())
	p := NewParser(Config{Columns: schema})
	_, err := p.Feed(data)
	assertParseErr(t, err, ErrFieldCountMismatch, 4)

	// an over-wide row is rejected at the same prefix offset
	wide := stream(row(rawField(nil), rawField(nil), rawField(nil)), terminator())
	p2 := NewParser(Config{Columns: schema})
	_, err = p2.Feed(wide)
	assertParseErr(t, err, ErrFieldCountMismatch, 4)
}

func TestPauseAndResume(t *testing.T) {
	schema := []FieldType{Text}
	data := stream(
		row(textField("alpha")),
		row(textField("beta")),
		row(textField("gamma")),
		terminator(),
	)

	var pausedAt []int
	p := NewParser(Config{
		Columns: schema,
		Callback: func(r Row) bool {
			pausedAt = append(pausedAt, r.Index)
			return true
		},
	})

	firstRowEnd := len(magicBytes()) + 2 + 4 + len("alpha")
	n, err := p.Feed(data)
	if !errors.Is(err, ErrPaused) {
		t.Fatalf("want ErrPaused, got %v", err)
	}
	if n != firstRowEnd {
		t.Fatalf("consumed %d, want %d", n, firstRowEnd)
	}
	if !p.Paused() || p.Delivered() != 1 {
		t.Fatalf("paused=%v delivered=%d", p.Paused(), p.Delivered())
	}

	// while paused, further Feed rejects and consumes nothing
	if n2, err2 := p.Feed([]byte{0x00}); n2 != 0 || !errors.Is(err2, ErrPaused) {
		t.Fatalf("paused Feed got n=%d err=%v", n2, err2)
	}

	for want := 1; want <= 2; want++ {
		err = p.Resume()
		if !errors.Is(err, ErrPaused) {
			t.Fatalf("resume %d want ErrPaused, got %v", want, err)
		}
		if p.Delivered() != want+1 {
			t.Fatalf("after resume %d delivered %d", want, p.Delivered())
		}
	}
	if err := p.Resume(); err != nil { // terminator consumed, no more rows
		t.Fatalf("final resume: %v", err)
	}
	if err := p.End(); err != nil {
		t.Fatalf("End: %v", err)
	}
	if p.Delivered() != 3 {
		t.Fatalf("delivered %d, want 3", p.Delivered())
	}
	wantText := []string{"alpha", "beta", "gamma"}
	for i, r := range p.Rows() {
		if r.Index != i || r.Fields[0].Text != wantText[i] {
			t.Fatalf("row %d = %+v", i, r)
		}
	}
	if len(pausedAt) != 3 || pausedAt[0] != 0 || pausedAt[2] != 2 {
		t.Fatalf("callback indices %v", pausedAt)
	}
}

func TestPauseAcrossByteChunks(t *testing.T) {
	schema := []FieldType{Raw}
	data := stream(
		row(rawField([]byte{1, 2, 3})),
		row(rawField([]byte{4})),
		terminator(),
	)
	p := NewParser(Config{
		Columns:  schema,
		Callback: func(Row) bool { return true },
	})
	feedByteByByte(t, p, data)
	if err := p.End(); err != nil {
		t.Fatalf("End: %v", err)
	}
	if p.Delivered() != 2 {
		t.Fatalf("delivered %d, want 2", p.Delivered())
	}
}

func TestPauseThenResumeWithNewChunks(t *testing.T) {
	schema := []FieldType{Raw}
	first := stream(row(rawField([]byte("aa"))))
	rest := append(row(rawField([]byte("bb"))), terminator()...)

	p := NewParser(Config{
		Columns:  schema,
		Callback: func(r Row) bool { return r.Index == 0 },
	})
	n, err := p.Feed(first)
	if !errors.Is(err, ErrPaused) || n != len(first) {
		t.Fatalf("first Feed: n=%d err=%v", n, err)
	}
	if p.Delivered() != 1 {
		t.Fatalf("delivered %d, want 1", p.Delivered())
	}
	// new chunks while paused are refused and not consumed
	if n2, err2 := p.Feed(rest); n2 != 0 || !errors.Is(err2, ErrPaused) {
		t.Fatalf("paused Feed rest: n=%d err=%v", n2, err2)
	}
	if err := p.Resume(); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	// after resume the buffered rest is parsed; second row does not pause
	if _, err := p.Feed(rest); err != nil {
		t.Fatalf("Feed rest after resume: %v", err)
	}
	if err := p.End(); err != nil {
		t.Fatalf("End: %v", err)
	}
	if p.Delivered() != 2 || string(p.Rows()[1].Fields[0].Data) != "bb" {
		t.Fatalf("unexpected rows: %+v", p.Rows())
	}
}

func TestIllegalUTF8ReportsSequenceStart(t *testing.T) {
	schema := []FieldType{Text}
	// valid two-byte rune then invalid continuation 0xFF.
	// magic(4) + count(2) + length(4) = 10, valid rune occupies 2 bytes,
	// so the illegal sequence starts at absolute offset 12.
	body := []byte{0xC3, 0xA9, 0xFF, 0x41}
	data := stream(row(textField(string(body))), terminator())
	p := NewParser(Config{Columns: schema})
	_, err := p.Feed(data)
	assertParseErr(t, err, ErrIllegalUTF8, 12)

	// truncated multibyte sequence: leading byte alone is invalid.
	body2 := []byte{'a', 0xE2, 0x82} // 0xE2 expects three bytes total
	data2 := stream(row(textField(string(body2))), terminator())
	p2 := NewParser(Config{Columns: schema})
	_, err = p2.Feed(data2)
	assertParseErr(t, err, ErrIllegalUTF8, 11)

	// same outcome when delivered one byte at a time
	p3 := NewParser(Config{Columns: schema})
	var lastErr error
	for i := 0; i < len(data); i++ {
		_, lastErr = p3.Feed(data[i : i+1])
		if lastErr != nil {
			break
		}
	}
	assertParseErr(t, lastErr, ErrIllegalUTF8, 12)
}

func TestNegativeLengthReportsPrefix(t *testing.T) {
	schema := []FieldType{Raw}
	data := magicBytes()
	data = append(data, fieldCount(1)...)
	data = append(data, lenPrefix(-2)...) // illegal, prefix at offset 6
	p := NewParser(Config{Columns: schema})
	_, err := p.Feed(data)
	assertParseErr(t, err, ErrIllegalLength, 6)
}

func TestMagicMismatchOffset(t *testing.T) {
	schema := []FieldType{Raw}
	bad := []byte{'R', 'X', 'W', '1'}
	p := NewParser(Config{Columns: schema})
	_, err := p.Feed(bad)
	assertParseErr(t, err, ErrMagicMismatch, 1)

	p2 := NewParser(Config{Columns: schema})
	var lastErr error
	for i := 0; i < len(bad); i++ {
		_, lastErr = p2.Feed(bad[i : i+1])
		if lastErr != nil {
			break
		}
	}
	assertParseErr(t, lastErr, ErrMagicMismatch, 1)
}

func TestTruncationReportsTotalInputLength(t *testing.T) {
	schema := []FieldType{Raw}

	// truncated field-count prefix
	d1 := append(magicBytes(), 0x00)
	p1 := NewParser(Config{Columns: schema})
	if _, err := p1.Feed(d1); err != nil {
		t.Fatalf("Feed d1: %v", err)
	}
	assertParseErr(t, p1.End(), ErrTruncated, int64(len(d1)))

	// truncated length prefix
	d2 := append(stream(), fieldCount(1)[0])
	p2 := NewParser(Config{Columns: schema})
	if _, err := p2.Feed(d2); err != nil {
		t.Fatalf("Feed d2: %v", err)
	}
	assertParseErr(t, p2.End(), ErrTruncated, int64(len(d2)))

	// truncated body: length says 4 bytes but only 2 arrive
	d3 := stream()
	d3 = append(d3, fieldCount(1)...)
	d3 = append(d3, lenPrefix(4)...)
	d3 = append(d3, 0x01, 0x02)
	p3 := NewParser(Config{Columns: schema})
	if _, err := p3.Feed(d3); err != nil {
		t.Fatalf("Feed d3: %v", err)
	}
	assertParseErr(t, p3.End(), ErrTruncated, int64(len(d3)))

	// byte-by-byte truncation keeps the same total
	p4 := NewParser(Config{Columns: schema})
	var lastErr error
	for i := 0; i < len(d3); i++ {
		_, lastErr = p4.Feed(d3[i : i+1])
		if lastErr != nil {
			t.Fatalf("byte %d unexpected err %v", i, lastErr)
		}
	}
	assertParseErr(t, p4.End(), ErrTruncated, int64(len(d3)))
}

func TestFieldAndRowLimits(t *testing.T) {
	schema := []FieldType{Raw, Raw}

	// single-field limit: length prefix at offset 6
	d1 := stream(row(rawField([]byte("abcdef")), rawField(nil)), terminator())
	p1 := NewParser(Config{Columns: schema, MaxFieldBytes: 5})
	_, err := p1.Feed(d1)
	assertParseErr(t, err, ErrFieldLimit, 6)

	// row cumulative limit: second field's length prefix at
	// 4 + 2 + 4 + 6 = 16
	d2 := stream(row(rawField([]byte("abcdef")), rawField([]byte("xyz"))), terminator())
	p2 := NewParser(Config{Columns: schema, MaxRowBytes: 8})
	_, err = p2.Feed(d2)
	assertParseErr(t, err, ErrRowLimit, 16)

	// limits are checked before reading any body: a declared overrun on a
	// truncated stream still reports the prefix, not truncation.
	d3 := stream()
	d3 = append(d3, fieldCount(1)...)
	d3 = append(d3, lenPrefix(99)...)
	p3 := NewParser(Config{Columns: []FieldType{Raw}, MaxFieldBytes: 10})
	_, err = p3.Feed(d3)
	assertParseErr(t, err, ErrFieldLimit, 6)

	// null fields do not count toward the row cumulative total
	d4 := stream(row(nullField(), rawField([]byte("ok"))), terminator())
	p4 := NewParser(Config{Columns: schema, MaxRowBytes: 2})
	if _, err := p4.Feed(d4); err != nil {
		t.Fatalf("null should not consume row budget: %v", err)
	}
	if err := p4.End(); err != nil {
		t.Fatalf("End: %v", err)
	}
}

func TestDeliveredRowsRetainedAfterError(t *testing.T) {
	schema := []FieldType{Raw}
	data := stream(
		row(rawField([]byte("one"))),
		row(rawField([]byte("two"))),
	)
	data = append(data, 0x00) // lone byte cannot start a count prefix; End truncates
	p := NewParser(Config{Columns: schema})
	if _, err := p.Feed(data); err != nil {
		t.Fatalf("Feed: %v", err)
	}
	err := p.End()
	assertParseErr(t, err, ErrTruncated, int64(len(data)))
	if p.Delivered() != 2 {
		t.Fatalf("delivered %d, want 2 retained rows", p.Delivered())
	}
	if string(p.Rows()[0].Fields[0].Data) != "one" ||
		string(p.Rows()[1].Fields[0].Data) != "two" {
		t.Fatalf("retained rows mismatch: %+v", p.Rows())
	}
}

func TestChunkBoundariesEquivalent(t *testing.T) {
	schema := []FieldType{Raw, Integer, Text}
	full := stream(
		row(rawField([]byte{0xDE, 0xAD}), intField(math.MinInt64), textField("héllo")),
		row(nullField(), nullField(), nullField()),
		row(rawField(nil), intField(math.MaxInt64), textField("")),
		terminator(),
	)

	reference := NewParser(Config{Columns: schema})
	if _, err := reference.Feed(full); err != nil {
		t.Fatalf("reference Feed: %v", err)
	}
	if err := reference.End(); err != nil {
		t.Fatalf("reference End: %v", err)
	}

	for _, size := range []int{1, 2, 3, 5, 7, 64} {
		p := NewParser(Config{Columns: schema})
		for start := 0; start < len(full); start += size {
			end := start + size
			if end > len(full) {
				end = len(full)
			}
			n, err := p.Feed(full[start:end])
			if err != nil {
				t.Fatalf("size %d at %d: %v", size, start, err)
			}
			if n < 0 || n > end-start {
				t.Fatalf("size %d at %d: consumed %d outside chunk %d", size, start, n, end-start)
			}
		}
		if err := p.End(); err != nil {
			t.Fatalf("size %d End: %v", size, err)
		}
		if p.base != int64(len(full)) || len(p.buf) != 0 {
			t.Fatalf("size %d left buffered data at position %d", size, p.base)
		}
		if p.Delivered() != reference.Delivered() {
			t.Fatalf("size %d delivered %d, want %d", size, p.Delivered(), reference.Delivered())
		}
		for i, r := range p.Rows() {
			ref := reference.Rows()[i]
			if len(r.Fields) != len(ref.Fields) {
				t.Fatalf("size %d row %d field count", size, i)
			}
			for j, f := range r.Fields {
				rf := ref.Fields[j]
				if f.Null != rf.Null || f.Int != rf.Int ||
					string(f.Data) != string(rf.Data) || f.Text != rf.Text {
					t.Fatalf("size %d row %d field %d: %+v != %+v", size, i, j, f, rf)
				}
			}
		}
	}
}

func TestParserStateAndErrorAccessors(t *testing.T) {
	schema := []FieldType{Raw}

	// End while paused reports ErrPaused; Resume afterwards still works.
	p := NewParser(Config{
		Columns:  schema,
		Callback: func(Row) bool { return true },
	})
	data := stream(row(rawField([]byte("x"))), terminator())
	if _, err := p.Feed(data); !errors.Is(err, ErrPaused) {
		t.Fatalf("want pause, got %v", err)
	}
	if err := p.End(); !errors.Is(err, ErrPaused) {
		t.Fatalf("paused End want ErrPaused, got %v", err)
	}
	if !p.Paused() || p.Fatal() != nil {
		t.Fatalf("paused=%v fatal=%v", p.Paused(), p.Fatal())
	}
	if err := p.Resume(); err != nil { // drains terminator
		t.Fatalf("Resume: %v", err)
	}
	if p.Paused() || p.End() != nil {
		t.Fatalf("parser should be clean after resume")
	}
	// Resume without an outstanding pause is a harmless no-op.
	if err := p.Resume(); err != nil {
		t.Fatalf("no-op Resume: %v", err)
	}

	// error formatting carries code text and offset; Fatal is sticky and
	// also blocks Resume.
	bad := append(magicBytes(), fieldCount(-2)...)
	p2 := NewParser(Config{Columns: schema})
	_, err := p2.Feed(bad)
	assertParseErr(t, err, ErrIllegalFieldCount, 4)
	if p2.Fatal() == nil || p2.Fatal().Error() == "" {
		t.Fatalf("Fatal accessor/Error string broken: %v", p2.Fatal())
	}
	if err := p2.Resume(); !errors.As(err, new(*ParseError)) {
		t.Fatalf("Resume after fatal want ParseError, got %v", err)
	}
	if err := p2.End(); !errors.As(err, new(*ParseError)) {
		t.Fatalf("End after fatal want ParseError, got %v", err)
	}

	// ErrorCode.String covers the full enum.
	codes := []ErrorCode{
		ErrMagicMismatch, ErrTruncated, ErrIllegalFieldCount,
		ErrFieldCountMismatch, ErrIllegalLength, ErrIntegerLength,
		ErrIllegalUTF8, ErrBytesAfterTerminator, ErrFieldLimit, ErrRowLimit,
		ErrorCode(99),
	}
	for _, c := range codes {
		if c.String() == "" {
			t.Fatalf("ErrorCode %d has empty String", c)
		}
	}
}

func TestNullIntegerAndUTF8EdgeBodies(t *testing.T) {
	schema := []FieldType{Integer, Text}
	// valid multibyte text including the boundary runes U+0800 and U+10000
	text := "a\u0800\U00010000z"
	data := stream(
		row(nullField(), textField(text)),
		row(intField(math.MaxInt64), textField("")),
		terminator(),
	)
	p := NewParser(Config{Columns: schema})
	if _, err := p.Feed(data); err != nil {
		t.Fatalf("Feed: %v", err)
	}
	if err := p.End(); err != nil {
		t.Fatalf("End: %v", err)
	}
	r0 := p.Rows()[0].Fields
	if !r0[0].Null || r0[0].Data != nil {
		t.Fatalf("null integer field: %+v", r0[0])
	}
	if r0[1].Text != text {
		t.Fatalf("text round trip = %q, want %q", r0[1].Text, text)
	}
	r1 := p.Rows()[1].Fields
	if r1[0].Int != math.MaxInt64 || r1[1].Null || r1[1].Text != "" {
		t.Fatalf("second row mismatch: %+v", r1)
	}
}

func TestPauseOnZeroColumnRow(t *testing.T) {
	data := stream(row(), row(), terminator())
	var calls int
	p := NewParser(Config{
		Columns:  []FieldType{},
		Callback: func(Row) bool { calls++; return true },
	})
	// first zero-column row pauses inside Feed
	n, err := p.Feed(data)
	if !errors.Is(err, ErrPaused) {
		t.Fatalf("want ErrPaused, got %v", err)
	}
	// consumed position lies inside the chunk, never past its end
	if n <= 0 || n > len(data) {
		t.Fatalf("paused consumed %d outside chunk of %d", n, len(data))
	}
	if calls != 1 || p.Delivered() != 1 {
		t.Fatalf("calls=%d delivered=%d", calls, p.Delivered())
	}
	// resume pauses again on the second row, then a final resume ends it
	if err := p.Resume(); !errors.Is(err, ErrPaused) || calls != 2 {
		t.Fatalf("second row: err=%v calls=%d", err, calls)
	}
	if err := p.Resume(); err != nil {
		t.Fatalf("final resume: %v", err)
	}
	if err := p.End(); err != nil || p.Delivered() != 2 {
		t.Fatalf("End err=%v delivered=%d", err, p.Delivered())
	}
}

func TestFatalErrorSurfacesDuringResume(t *testing.T) {
	schema := []FieldType{Text}
	// first row pauses; the remainder, already buffered behind it, starts a
	// second row whose text body contains an illegal UTF-8 byte.
	illegalBody := []byte{0xFF}
	remainder := row(textField(string(illegalBody)))
	remainder = append(remainder, terminator()...)
	good := stream(row(textField("ok")))
	full := append(good, remainder...)

	p := NewParser(Config{
		Columns:  schema,
		Callback: func(r Row) bool { return r.Index == 0 },
	})
	if _, err := p.Feed(full); !errors.Is(err, ErrPaused) {
		t.Fatalf("want initial pause, got %v", err)
	}
	// while paused, extra input is rejected without consumption
	if n, err := p.Feed(remainder); n != 0 || !errors.Is(err, ErrPaused) {
		t.Fatalf("paused feed got n=%d err=%v", n, err)
	}
	err := p.Resume()
	// first row is 4+2+4+2 = 12 bytes; the second row's body starts after
	// its count(2)+length(4) prefix, at absolute offset 12+2+4 = 18.
	assertParseErr(t, err, ErrIllegalUTF8, 18)
	if p.Fatal() == nil || p.Delivered() != 1 {
		t.Fatalf("fatal=%v delivered=%d, want first row retained", p.Fatal(), p.Delivered())
	}
}
