package auditlog

import (
	"bytes"
	"testing"
)

func TestEncodeScanRoundTrip(t *testing.T) {
	var buf []byte
	want := []Entry{
		{Seq: 1, Payload: []byte("hello")},
		{Seq: 2, Payload: []byte("")},
		{Seq: 1 << 40, Payload: bytes.Repeat([]byte("x"), 1000)},
	}
	var off int64
	for i := range want {
		frame := EncodeFrame(want[i].Seq, want[i].Payload)
		want[i].Offset = off
		want[i].Payload = append([]byte(nil), want[i].Payload...)
		off += int64(len(frame))
		buf = append(buf, frame...)
	}
	entries, validLen, err := Scan(bytes.NewReader(buf), int64(len(buf)))
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if validLen != int64(len(buf)) {
		t.Fatalf("validLen=%d want %d", validLen, len(buf))
	}
	if len(entries) != len(want) {
		t.Fatalf("got %d entries, want %d", len(entries), len(want))
	}
	for i, e := range entries {
		if e.Seq != want[i].Seq || e.Offset != want[i].Offset || !bytes.Equal(e.Payload, want[i].Payload) {
			t.Errorf("entry %d = %+v, want %+v", i, e, want[i])
		}
	}
}

func TestScanEmpty(t *testing.T) {
	entries, validLen, err := Scan(bytes.NewReader(nil), 0)
	if err != nil || len(entries) != 0 || validLen != 0 {
		t.Fatalf("Scan(empty) = %v, %d, %v", entries, validLen, err)
	}
}
