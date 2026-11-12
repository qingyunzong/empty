package dataeng

import (
	"encoding/binary"
	"reflect"
	"strings"
	"testing"
)

// recorder is a Handler that keeps every delivered frame in order.
type recorder struct {
	events []any
}

func (r *recorder) OnMethod(m MethodFrame)          { r.events = append(r.events, m) }
func (r *recorder) OnContentHeader(h ContentHeader) { r.events = append(r.events, h) }
func (r *recorder) OnBody(b BodyFrame)              { r.events = append(r.events, b) }
func (r *recorder) OnHeartbeat()                    { r.events = append(r.events, "heartbeat") }

// The helpers below assemble wire bytes by hand so the expected
// frames never come from the component under test.

func rawFrame(typ byte, channel uint16, payload []byte) []byte {
	frame := make([]byte, 0, 7+len(payload)+1)
	frame = append(frame, typ)
	frame = binary.BigEndian.AppendUint16(frame, channel)
	frame = binary.BigEndian.AppendUint32(frame, uint32(len(payload)))
	frame = append(frame, payload...)
	return append(frame, FrameEnd)
}

func heartbeatBytes() []byte {
	return []byte{FrameHeartbeat, 0, 0, 0, 0, 0, 0, FrameEnd}
}

func methodBytes(channel, classID, methodID uint16, args []byte) []byte {
	payload := make([]byte, 0, 4+len(args))
	payload = binary.BigEndian.AppendUint16(payload, classID)
	payload = binary.BigEndian.AppendUint16(payload, methodID)
	payload = append(payload, args...)
	return rawFrame(FrameMethod, channel, payload)
}

func headerBytes(channel, classID, weight uint16, bodySize uint64, props []byte) []byte {
	payload := make([]byte, 0, 12+len(props))
	payload = binary.BigEndian.AppendUint16(payload, classID)
	payload = binary.BigEndian.AppendUint16(payload, weight)
	payload = binary.BigEndian.AppendUint64(payload, bodySize)
	payload = append(payload, props...)
	return rawFrame(FrameHeader, channel, payload)
}

func bodyBytes(channel uint16, chunk []byte) []byte {
	return rawFrame(FrameBody, channel, chunk)
}

func concat(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}

func pushAll(t *testing.T, p *Parser, data []byte) {
	t.Helper()
	if err := p.Push(data); err != nil {
		t.Fatalf("Push: %v", err)
	}
}

func TestInterleavedChannels(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	stream := concat(
		headerBytes(1, 60, 0, 10, []byte{0x80, 0x00}),
		bodyBytes(1, []byte("he")),
		headerBytes(2, 60, 0, 3, []byte{0x00, 0x00}),
		bodyBytes(2, []byte("two")),
		bodyBytes(1, []byte("llo ")),
		bodyBytes(1, []byte("wor")),
		bodyBytes(1, []byte("d")),
		headerBytes(1, 60, 0, 0, []byte{0x00, 0x00}),
	)
	pushAll(t, p, stream)
	if err := p.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	want := []any{
		ContentHeader{Channel: 1, ClassID: 60, BodySize: 10, Props: []byte{0x80, 0x00}},
		BodyFrame{Channel: 1, Payload: []byte("he")},
		ContentHeader{Channel: 2, ClassID: 60, BodySize: 3, Props: []byte{0x00, 0x00}},
		BodyFrame{Channel: 2, Payload: []byte("two")},
		BodyFrame{Channel: 1, Payload: []byte("llo ")},
		BodyFrame{Channel: 1, Payload: []byte("wor")},
		BodyFrame{Channel: 1, Payload: []byte("d")},
		ContentHeader{Channel: 1, ClassID: 60, BodySize: 0, Props: []byte{0x00, 0x00}},
	}
	if !reflect.DeepEqual(rec.events, want) {
		t.Fatalf("events:\n got %#v\nwant %#v", rec.events, want)
	}
}

func TestHeartbeatAndMethodInsideBody(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	stream := concat(
		headerBytes(1, 60, 0, 4, []byte{0x00, 0x01}),
		bodyBytes(1, []byte("ab")),
		heartbeatBytes(),
		methodBytes(1, 60, 40, []byte{0xde, 0xad}),
		bodyBytes(1, []byte("cd")),
		heartbeatBytes(),
	)
	pushAll(t, p, stream)
	if err := p.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	want := []any{
		ContentHeader{Channel: 1, ClassID: 60, BodySize: 4, Props: []byte{0x00, 0x01}},
		BodyFrame{Channel: 1, Payload: []byte("ab")},
		"heartbeat",
		MethodFrame{Channel: 1, ClassID: 60, MethodID: 40, Args: []byte{0xde, 0xad}},
		BodyFrame{Channel: 1, Payload: []byte("cd")},
		"heartbeat",
	}
	if !reflect.DeepEqual(rec.events, want) {
		t.Fatalf("events:\n got %#v\nwant %#v", rec.events, want)
	}
}

func TestBodyExceedsRemainingByOne(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	pushAll(t, p, concat(
		headerBytes(1, 60, 0, 5, []byte{0x00, 0x00}),
		bodyBytes(1, []byte("12345")),
	))
	if err := p.Push(bodyBytes(1, []byte("6"))); err == nil {
		t.Fatal("Push: expected error for body exceeding remaining by one byte")
	}
	if p.Err() == nil {
		t.Fatal("parser not stopped after failure")
	}
	if err := p.Push(bodyBytes(1, []byte("x"))); err == nil {
		t.Fatal("Push after failure: expected stored error")
	}
	if err := p.Finish(); err == nil {
		t.Fatal("Finish after failure: expected stored error")
	}

	want := []any{
		ContentHeader{Channel: 1, ClassID: 60, BodySize: 5, Props: []byte{0x00, 0x00}},
		BodyFrame{Channel: 1, Payload: []byte("12345")},
	}
	if !reflect.DeepEqual(rec.events, want) {
		t.Fatalf("delivered frames before failure:\n got %#v\nwant %#v", rec.events, want)
	}
}

func TestNonZeroWeightRejected(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	err := p.Push(headerBytes(1, 60, 1, 0, []byte{0x00, 0x00}))
	if err == nil {
		t.Fatal("Push: expected error for non-zero weight")
	}
	if !strings.Contains(err.Error(), "weight") {
		t.Fatalf("error should mention weight, got %v", err)
	}
	if len(rec.events) != 0 {
		t.Fatalf("no frame should be delivered, got %#v", rec.events)
	}
}

func TestSplitFrame(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	stream := concat(
		methodBytes(1, 10, 11, []byte{1, 2, 3}),
		headerBytes(1, 60, 0, 3, []byte{0x00, 0x00}),
		bodyBytes(1, []byte("xyz")),
		heartbeatBytes(),
	)
	for i, b := range stream {
		if err := p.Push([]byte{b}); err != nil {
			t.Fatalf("Push byte %d: %v", i, err)
		}
	}
	if err := p.Finish(); err != nil {
		t.Fatalf("Finish: %v", err)
	}

	want := []any{
		MethodFrame{Channel: 1, ClassID: 10, MethodID: 11, Args: []byte{1, 2, 3}},
		ContentHeader{Channel: 1, ClassID: 60, BodySize: 3, Props: []byte{0x00, 0x00}},
		BodyFrame{Channel: 1, Payload: []byte("xyz")},
		"heartbeat",
	}
	if !reflect.DeepEqual(rec.events, want) {
		t.Fatalf("events:\n got %#v\nwant %#v", rec.events, want)
	}
}

func TestMissingFrameEnd(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	frame := methodBytes(1, 10, 11, nil)
	frame[len(frame)-1] = 0x00
	if err := p.Push(frame); err == nil {
		t.Fatal("Push: expected error for missing 0xCE")
	}
}

func TestUnknownFrameType(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	if err := p.Push(rawFrame(4, 1, nil)); err == nil {
		t.Fatal("Push: expected error for unknown frame type")
	}
}

func TestChannelZeroOnlyHeartbeat(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	if err := p.Push(methodBytes(0, 10, 10, nil)); err == nil {
		t.Fatal("Push: expected error for method on channel 0")
	}
}

func TestHeartbeatRequiresZeroChannelAndLength(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	if err := p.Push(rawFrame(FrameHeartbeat, 1, nil)); err == nil {
		t.Fatal("Push: expected error for heartbeat on channel 1")
	}

	p2 := NewParser(4096, &recorder{})
	if err := p2.Push(rawFrame(FrameHeartbeat, 0, []byte{0x01})); err == nil {
		t.Fatal("Push: expected error for heartbeat with payload")
	}
}

func TestNewContentHeaderBeforeBodyComplete(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	pushAll(t, p, concat(
		headerBytes(1, 60, 0, 5, []byte{0x00, 0x00}),
		bodyBytes(1, []byte("ab")),
	))
	if err := p.Push(headerBytes(1, 60, 0, 1, []byte{0x00, 0x00})); err == nil {
		t.Fatal("Push: expected error for content header while body unfinished")
	}
}

func TestOversizedFrameRejectedAfterLengthReadable(t *testing.T) {
	rec := &recorder{}
	p := NewParser(16, rec)

	header := make([]byte, 0, 7)
	header = append(header, FrameMethod)
	header = binary.BigEndian.AppendUint16(header, 1)
	header = binary.BigEndian.AppendUint32(header, 17)
	if err := p.Push(header); err == nil {
		t.Fatal("Push: expected error once the 4-byte length is readable")
	}
	if len(rec.events) != 0 {
		t.Fatalf("no frame should be delivered, got %#v", rec.events)
	}
}

func TestFinishWithIncompleteFrame(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	pushAll(t, p, methodBytes(1, 10, 11, nil)[:5])
	if err := p.Finish(); err == nil {
		t.Fatal("Finish: expected error for incomplete frame")
	}
}

func TestFinishWithUnfinishedBody(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	pushAll(t, p, concat(
		headerBytes(1, 60, 0, 4, []byte{0x00, 0x00}),
		bodyBytes(1, []byte("abc")),
	))
	if err := p.Finish(); err == nil {
		t.Fatal("Finish: expected error for unfinished body")
	}
}

func TestBodyWithoutContentHeader(t *testing.T) {
	rec := &recorder{}
	p := NewParser(4096, rec)

	if err := p.Push(bodyBytes(1, []byte("x"))); err == nil {
		t.Fatal("Push: expected error for body without content header")
	}
}
