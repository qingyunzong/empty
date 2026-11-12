package dataeng_test

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	dataeng "example.org/dataeng/q0271"
)

func TestPositionAndErrorMessage(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(10, 1))

	r, err := dataeng.NewReader(context.Background(), &chunkReader{data: enc.buf, size: 8},
		func(rec dataeng.Record) error { return nil }, dataeng.Options{})
	if err != nil {
		t.Fatalf("construct err=%v", err)
	}
	if r.Position() != 0 {
		t.Fatalf("initial position=%d want 0", r.Position())
	}
	if err := r.Read(); err != io.EOF {
		t.Fatalf("read err=%v", err)
	}
	if r.Position() != int64(len(enc.buf)) {
		t.Fatalf("position=%d want=%d", r.Position(), len(enc.buf))
	}

	// 干净 EOF 后再次读取稳定返回 io.EOF。
	err = r.Read()
	if !errors.Is(err, io.EOF) {
		t.Fatalf("post-EOF read err=%v want EOF", err)
	}
}

func TestCheckpointUnavailableBeforeAnyRecord(t *testing.T) {
	r, err := dataeng.NewReader(context.Background(), &chunkReader{data: nil, size: 4},
		nil, dataeng.Options{})
	if err != nil {
		t.Fatalf("construct err=%v", err)
	}
	if err := r.Read(); err != io.EOF {
		t.Fatalf("read err=%v", err)
	}
	if cp, ok := r.Checkpoint(); ok {
		t.Fatalf("checkpoint %+v must be unavailable before any confirmed record", cp)
	}
}

func TestTruncationReportFields(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(10, 1))
	last := enc.records[0].fragments[0]
	// 在唯一记录的载荷中间截断：恢复模式丢弃该尾记录并给出报告。
	data := enc.truncate(int(last.start) + encHeaderSize + 4)
	got, trunc, err := runReader(t, data, 5, dataeng.Options{Mode: dataeng.Recovery})
	if err != nil {
		t.Fatalf("recovery err=%v", err)
	}
	if len(got) != 0 {
		t.Fatalf("truncated record must not be delivered")
	}
	if trunc == nil || trunc.Reason != dataeng.TruncatedPayload {
		t.Fatalf("trunc=%+v", trunc)
	}
	if trunc.LogicalStart != last.start {
		t.Fatalf("logical start=%d want=%d", trunc.LogicalStart, last.start)
	}
	if trunc.BytesDropped != int64(len(data))-last.start {
		t.Fatalf("dropped=%d", trunc.BytesDropped)
	}
	if !strings.Contains(trunc.Reason.String(), "payload") {
		t.Fatalf("reason text=%q", trunc.Reason.String())
	}
}
