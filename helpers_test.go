package dataeng_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"io"
	"testing"

	dataeng "example.org/dataeng/q0271"
)

type chunkReader struct {
	data []byte
	size int
	pos  int
}

// limitedEOF 在提供 limit 字节后返回 EOF，模拟“只到某确认边界的前缀文件”。
type limitedEOF struct {
	data  []byte
	limit int
	pos   int
}

func (l *limitedEOF) Read(p []byte) (int, error) {
	if l.pos >= l.limit {
		return 0, io.EOF
	}
	n := copy(p, l.data[l.pos:l.limit])
	l.pos += n
	return n, nil
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if c.pos >= len(c.data) {
		return 0, io.EOF
	}
	n := copy(p, c.data[c.pos:])
	if n > c.size {
		n = c.size
	}
	c.pos += n
	return n, nil
}

type gotRecord struct {
	payload []byte
	start   int64
	ranges  []dataeng.PayloadRange
}

func runReader(t *testing.T, data []byte, chunkSize int, opts dataeng.Options) ([]gotRecord, *dataeng.Truncation, error) {
	t.Helper()
	var got []gotRecord
	r, err := dataeng.NewReader(context.Background(), &chunkReader{data: data, size: chunkSize},
		func(rec dataeng.Record) error {
			payload := make([]byte, len(rec.Payload))
			copy(payload, rec.Payload)
			got = append(got, gotRecord{
				payload: payload,
				start:   rec.LogicalStart,
				ranges:  append([]dataeng.PayloadRange(nil), rec.Ranges...),
			})
			return nil
		}, opts)
	if err != nil {
		return nil, nil, err
	}
	err = r.Read()
	return got, r.Truncation(), err
}

func payloadBytes(size int, seed byte) []byte {
	b := make([]byte, size)
	for i := range b {
		b[i] = byte(i)*31 + seed
	}
	return b
}

func verifyRecords(t *testing.T, enc *encoder, got []gotRecord) {
	t.Helper()
	if len(got) != len(enc.records) {
		t.Fatalf("record count: got %d want %d", len(got), len(enc.records))
	}
	for i, rec := range enc.records {
		if got[i].start != rec.logicalStart {
			t.Fatalf("rec %d logical start: got %d want %d", i, got[i].start, rec.logicalStart)
		}
		if !bytes.Equal(got[i].payload, rec.payload) {
			t.Fatalf("rec %d payload mismatch", i)
		}
		if len(got[i].ranges) != len(rec.fragments) {
			t.Fatalf("rec %d ranges count: got %d want %d", i, len(got[i].ranges), len(rec.fragments))
		}
		var reassembled []byte
		for j, f := range rec.fragments {
			wantStart := f.start + encHeaderSize
			if got[i].ranges[j].Start != wantStart || got[i].ranges[j].Length != int64(len(f.payload)) {
				t.Fatalf("rec %d frag %d range mismatch", i, j)
			}
			reassembled = append(reassembled, f.payload...)
		}
		if !bytes.Equal(reassembled, rec.payload) {
			t.Fatalf("rec %d range reassembly mismatch", i)
		}
	}
}

func assertKind(t *testing.T, err error, kind dataeng.ErrorKind, offset int64) {
	t.Helper()
	var pe *dataeng.Error
	if !errors.As(err, &pe) {
		t.Fatalf("err=%v, want *dataeng.Error", err)
	}
	if pe.Kind != kind {
		t.Fatalf("kind=%s want=%s offset=%d", pe.Kind, kind, pe.Offset)
	}
	if offset >= 0 && pe.Offset != offset {
		t.Fatalf("offset=%d want=%d", pe.Offset, offset)
	}
}

// makeRawHeader 手工构造片头条目，用于损坏与越界用例。
func makeRawHeader(typ byte, length int) []byte {
	hdr := make([]byte, encHeaderSize)
	body := make([]byte, length&0xFFFF)
	binary.LittleEndian.PutUint32(hdr[0:4], encCRC(typ, body))
	binary.LittleEndian.PutUint16(hdr[4:6], uint16(length))
	hdr[6] = typ
	return hdr
}
