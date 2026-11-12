package resultset

import (
	"bytes"
	"strings"
	"testing"
)

// packet builds one wire packet: 3-byte little-endian length, 1-byte
// sequence, payload. Tests assemble packets on their own; expected rows
// are literals and never come from the component under test.
func packet(seq uint8, payload []byte) []byte {
	b := make([]byte, 4+len(payload))
	b[0] = byte(len(payload))
	b[1] = byte(len(payload) >> 8)
	b[2] = byte(len(payload) >> 16)
	b[3] = seq
	copy(b[4:], payload)
	return b
}

func lenEnc(n uint64) []byte {
	switch {
	case n <= 250:
		return []byte{byte(n)}
	case n <= 0xFFFF:
		return []byte{0xFC, byte(n), byte(n >> 8)}
	case n <= 0xFFFFFF:
		return []byte{0xFD, byte(n), byte(n >> 8), byte(n >> 16)}
	default:
		b := make([]byte, 9)
		b[0] = 0xFE
		for i := 0; i < 8; i++ {
			b[1+i] = byte(n >> (8 * i))
		}
		return b
	}
}

func eofPayload(warnings, status uint16) []byte {
	return []byte{0xFE, byte(warnings), byte(warnings >> 8), byte(status), byte(status >> 8)}
}

func concat(parts ...[]byte) []byte {
	return bytes.Join(parts, nil)
}

const testMaxPayload = 1 << 20

func TestLongStringFirstColumnNotEOF(t *testing.T) {
	// A first column longer than 8 bytes starts with 0xFE and must be
	// parsed as a length-encoded string, not as an end packet.
	long := strings.Repeat("ab", 200) // 400 bytes
	// Encode the length with the 0xFE + uint64 little-endian form so
	// the row payload starts with 0xFE and is well over 9 bytes.
	rowPayload := make([]byte, 9, 9+len(long))
	rowPayload[0] = 0xFE
	for i := 0; i < 8; i++ {
		rowPayload[1+i] = byte(len(long) >> (8 * i))
	}
	rowPayload = append(rowPayload, long...)
	if rowPayload[0] != 0xFE || len(rowPayload) < 9 {
		t.Fatalf("test setup: payload should start with 0xFE and be >= 9 bytes")
	}
	stream := concat(
		packet(0, []byte{1}),             // column count = 1
		packet(1, []byte("coldef-raw")),  // column definition, kept as-is
		packet(2, eofPayload(0, 0x0002)), // end of column definitions
		packet(3, rowPayload),            // the row with the long string
		packet(4, eofPayload(1, 0x0002)), // end of rows
	)
	p := NewParser(testMaxPayload, 0)
	if err := p.Push(stream); err != nil {
		t.Fatalf("Push: %v", err)
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if res.ColumnCount != 1 {
		t.Fatalf("ColumnCount = %d, want 1", res.ColumnCount)
	}
	if string(res.Columns[0]) != "coldef-raw" {
		t.Fatalf("column definition = %q, want %q", res.Columns[0], "coldef-raw")
	}
	if len(res.Rows) != 1 {
		t.Fatalf("got %d rows, want 1", len(res.Rows))
	}
	if got := string(res.Rows[0][0]); got != long {
		t.Fatalf("row value truncated or wrong: got %d bytes, want %d", len(got), len(long))
	}
	if res.Warnings != 1 || res.Status != 0x0002 {
		t.Fatalf("end packet: warnings=%d status=%#x, want 1 and 0x2", res.Warnings, res.Status)
	}
}

func TestNullAndEmptyValues(t *testing.T) {
	// Row: NULL, empty string, "x". NULL is 0xFB with no following bytes;
	// empty string is length 0 and must stay non-nil.
	rowPayload := []byte{0xFB, 0x00, 0x01, 'x'}
	stream := concat(
		packet(0, []byte{3}),
		packet(1, []byte("c1")),
		packet(2, []byte("c2")),
		packet(3, []byte("c3")),
		packet(4, eofPayload(0, 0)),
		packet(5, rowPayload),
		packet(6, eofPayload(0, 0)),
	)
	p := NewParser(testMaxPayload, 0)
	if err := p.Push(stream); err != nil {
		t.Fatalf("Push: %v", err)
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(res.Rows) != 1 || len(res.Rows[0]) != 3 {
		t.Fatalf("rows = %v, want 1 row of 3 columns", res.Rows)
	}
	if res.Rows[0][0] != nil {
		t.Fatalf("column 0 = %v, want NULL (nil)", res.Rows[0][0])
	}
	if res.Rows[0][1] == nil || len(res.Rows[0][1]) != 0 {
		t.Fatalf("column 1 = %v, want non-nil empty string", res.Rows[0][1])
	}
	if string(res.Rows[0][2]) != "x" {
		t.Fatalf("column 2 = %q, want %q", res.Rows[0][2], "x")
	}
}

func TestSequenceWraparound(t *testing.T) {
	// Start at 253 so the sequence rolls 255 -> 0 mid-stream.
	stream := concat(
		packet(253, []byte{1}),
		packet(254, []byte("c")),
		packet(255, eofPayload(0, 0)),
		packet(0, []byte{0x01, 'a'}),
		packet(1, eofPayload(0, 0)),
	)
	p := NewParser(testMaxPayload, 253)
	if err := p.Push(stream); err != nil {
		t.Fatalf("Push: %v", err)
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(res.Rows) != 1 || string(res.Rows[0][0]) != "a" {
		t.Fatalf("rows = %v, want one row [a]", res.Rows)
	}
}

func TestSequenceMismatch(t *testing.T) {
	p := NewParser(testMaxPayload, 7)
	if err := p.Push(packet(8, []byte{1})); err == nil {
		t.Fatal("expected sequence mismatch error")
	}
	// Sticky: the component stays stopped.
	if err := p.Push(packet(7, []byte{1})); err == nil {
		t.Fatal("expected sticky error after failure")
	}
}

func TestColumnCountMismatch(t *testing.T) {
	prefix := concat(
		packet(0, []byte{2}),
		packet(1, []byte("c1")),
		packet(2, []byte("c2")),
		packet(3, eofPayload(0, 0)),
	)
	t.Run("too few", func(t *testing.T) {
		p := NewParser(testMaxPayload, 0)
		stream := concat(prefix, packet(4, []byte{0x01, 'a'}))
		if err := p.Push(stream); err == nil {
			t.Fatal("expected error for row with fewer columns")
		}
	})
	t.Run("too many", func(t *testing.T) {
		p := NewParser(testMaxPayload, 0)
		stream := concat(prefix, packet(4, []byte{0x01, 'a', 0x01, 'b', 0x01, 'c'}))
		if err := p.Push(stream); err == nil {
			t.Fatal("expected error for row with more columns")
		}
	})
}

func TestSplitLengthAndPacketBoundaries(t *testing.T) {
	stream := concat(
		packet(0, []byte{1}),
		packet(1, []byte("c")),
		packet(2, eofPayload(0, 0)),
		packet(3, []byte{0x02, 'h', 'i'}),
		packet(4, eofPayload(0, 0)),
	)
	// Push one byte at a time: the 3-byte length, the sequence byte and
	// the payload are all cut across Push calls.
	p := NewParser(testMaxPayload, 0)
	for i := 0; i < len(stream); i++ {
		if err := p.Push(stream[i : i+1]); err != nil {
			t.Fatalf("Push byte %d: %v", i, err)
		}
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if len(res.Rows) != 1 || string(res.Rows[0][0]) != "hi" {
		t.Fatalf("rows = %v, want one row [hi]", res.Rows)
	}
}

func TestFinishFailsOnIncompletePacket(t *testing.T) {
	full := packet(0, []byte{1})
	p := NewParser(testMaxPayload, 0)
	if err := p.Push(full[:len(full)-1]); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if _, err := p.Finish(); err == nil {
		t.Fatal("expected Finish to fail with a packet cut short")
	}
}

func TestZeroLengthRejectedAtThreeBytes(t *testing.T) {
	p := NewParser(testMaxPayload, 0)
	// Only the 3 length bytes are pushed; rejection must happen now,
	// without waiting for the sequence byte or payload.
	if err := p.Push([]byte{0x00, 0x00, 0x00}); err == nil {
		t.Fatal("expected zero payload length to be rejected once 3 bytes are complete")
	}
}

func TestOversizeLengthRejectedAtThreeBytes(t *testing.T) {
	p := NewParser(100, 0)
	// Declared length 0x010203 far exceeds maxPayload; 3 bytes suffice
	// to reject, no allocation of the declared size may happen first.
	if err := p.Push([]byte{0x03, 0x02, 0x01}); err == nil {
		t.Fatal("expected oversized payload length to be rejected once 3 bytes are complete")
	}
}

func TestErrorPacket(t *testing.T) {
	msg := "表不存在"
	payload := concat(
		[]byte{0xFF, 0x94, 0x04, '#'},
		[]byte("42S02"),
		[]byte(msg),
	)
	p := NewParser(testMaxPayload, 0)
	if err := p.Push(packet(0, payload)); err != nil {
		t.Fatalf("Push: %v", err)
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if res.Err == nil {
		t.Fatal("expected delivered error packet")
	}
	if res.Err.Code != 0x0494 || res.Err.State != "42S02" || res.Err.Message != msg {
		t.Fatalf("error packet = %+v", res.Err)
	}
}

func TestErrorPacketInvalidUTF8(t *testing.T) {
	payload := concat(
		[]byte{0xFF, 0x01, 0x00, '#'},
		[]byte("HY000"),
		[]byte{0xFF, 0xFE}, // not valid UTF-8
	)
	p := NewParser(testMaxPayload, 0)
	if err := p.Push(packet(0, payload)); err == nil {
		t.Fatal("expected invalid UTF-8 message to fail")
	}
}

func TestLengthPositionRejectsFB(t *testing.T) {
	p := NewParser(testMaxPayload, 0)
	if err := p.Push(packet(0, []byte{0xFB})); err == nil {
		t.Fatal("expected 0xFB in length position to fail")
	}
}

func TestDeliveredPacketsSurviveFailure(t *testing.T) {
	good := concat(
		packet(0, []byte{1}),
		packet(1, []byte("c")),
		packet(2, eofPayload(0, 0)),
		packet(3, []byte{0x01, 'z'}),
	)
	p := NewParser(testMaxPayload, 0)
	if err := p.Push(good); err != nil {
		t.Fatalf("Push good: %v", err)
	}
	if err := p.Push(packet(9, []byte{0x01, 'q'})); err == nil {
		t.Fatal("expected sequence error")
	}
	res, err := p.Finish()
	if err == nil {
		t.Fatal("expected sticky error from Finish")
	}
	if len(res.Rows) != 1 || string(res.Rows[0][0]) != "z" {
		t.Fatalf("delivered rows lost after failure: %v", res.Rows)
	}
}

func TestLenEncWidths(t *testing.T) {
	// 0xFC (uint16) and 0xFD (3-byte) length encodings inside a row.
	small := strings.Repeat("s", 251)   // needs 0xFC
	large := strings.Repeat("L", 70000) // needs 0xFD
	rowPayload := concat(
		lenEnc(uint64(len(small))), []byte(small),
		lenEnc(uint64(len(large))), []byte(large),
	)
	stream := concat(
		packet(0, []byte{2}),
		packet(1, []byte("c1")),
		packet(2, []byte("c2")),
		packet(3, eofPayload(0, 0)),
		packet(4, rowPayload),
		packet(5, eofPayload(0, 0)),
	)
	p := NewParser(testMaxPayload, 0)
	if err := p.Push(stream); err != nil {
		t.Fatalf("Push: %v", err)
	}
	res, err := p.Finish()
	if err != nil {
		t.Fatalf("Finish: %v", err)
	}
	if string(res.Rows[0][0]) != small || string(res.Rows[0][1]) != large {
		t.Fatalf("row values wrong: got lengths %d and %d", len(res.Rows[0][0]), len(res.Rows[0][1]))
	}
}
