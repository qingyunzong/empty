package dataeng

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"
)

func testOrder(e Endian) binary.ByteOrder {
	if e == BigEndian {
		return binary.BigEndian
	}
	return binary.LittleEndian
}

func putTestValue(b []byte, e Endian, typ ValueType, v any) {
	bo := testOrder(e)
	switch typ {
	case TypeI16:
		bo.PutUint16(b, uint16(v.(int16)))
	case TypeI32:
		bo.PutUint32(b, uint32(v.(int32)))
	case TypeF64Bits:
		bo.PutUint64(b, v.(uint64))
	case TypeTimestamp:
		ts := v.(Timestamp)
		bo.PutUint64(b[:8], ts.Fraction)
		bo.PutUint64(b[8:], uint64(ts.Seconds))
	}
}

func mustIngest(t *testing.T, eng *Engine, seg Segment) {
	t.Helper()
	if err := eng.Ingest(seg); err != nil {
		t.Fatalf("ingest segment %d: %v", seg.SegmentNumber, err)
	}
}

func assertReject(t *testing.T, err error, target error) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error wrapping %v, got nil", target)
	}
	if !errors.Is(err, target) {
		t.Fatalf("expected error wrapping %v, got %v", target, err)
	}
}

func testBudget() Budget {
	return Budget{MaxChannelsPerSegment: 16, MaxChunksPerSegment: 1 << 20, MaxCachedIndexes: 64}
}

func rawSeg(num int64, e Endian, newList bool, layout RawLayout, updates []Update, raw []byte) Segment {
	return Segment{
		SegmentNumber: num,
		Endian:        e,
		NewList:       newList,
		Layout:        layout,
		Updates:       updates,
		Reader:        bytes.NewReader(raw),
		RawOffset:     0,
		RawLength:     int64(len(raw)),
	}
}

func readAll(t *testing.T, h *Handle) []Result {
	t.Helper()
	rs, err := h.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	return rs
}
