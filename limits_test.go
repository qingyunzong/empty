package dataeng_test

import (
	"context"
	"testing"

	dataeng "example.org/dataeng/q0271"
)

func TestMaxRecordLimit(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(100, 1))
	enc.PutChunks(payloadBytes(1000, 2), 50)

	got, _, err := runReader(t, enc.buf, 17, dataeng.Options{
		Mode:           dataeng.Strict,
		MaxRecordBytes: 500,
	})
	assertKind(t, err, dataeng.ErrRecordTooLarge, -1)
	if len(got) != 1 {
		t.Fatalf("first record should be delivered before limit hit, got %d", len(got))
	}
}

func TestMaxTotalLimit(t *testing.T) {
	enc := &encoder{}
	enc.PutFull(payloadBytes(100, 1))
	enc.PutFull(payloadBytes(100, 2))
	enc.PutFull(payloadBytes(100, 3))

	var count int
	r2, err := dataeng.NewReader(context.Background(), &chunkReader{data: enc.buf, size: 19},
		func(rec dataeng.Record) error {
			count++
			return nil
		}, dataeng.Options{MaxTotalBytes: 250})
	if err != nil {
		t.Fatalf("construct err=%v", err)
	}
	err = r2.Read()
	assertKind(t, err, dataeng.ErrTotalLimit, -1)
	if count != 2 {
		t.Fatalf("total limit should stop before 3rd record, count=%d", count)
	}
}

func TestInvalidOptions(t *testing.T) {
	if _, err := dataeng.NewReader(context.Background(), &chunkReader{}, nil,
		dataeng.Options{MaxRecordBytes: -1}); err == nil {
		t.Fatalf("negative MaxRecordBytes must fail")
	}
	if _, err := dataeng.NewReader(context.Background(), &chunkReader{}, nil,
		dataeng.Options{MaxTotalBytes: -1}); err == nil {
		t.Fatalf("negative MaxTotalBytes must fail")
	}
}
