package dataeng

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"
	"time"
)

type shardPayload struct {
	shard   Shard
	payload []byte
}

func encodeLines(t *testing.T, lines []string, finalNewline bool) []byte {
	t.Helper()
	var plain bytes.Buffer
	for i, line := range lines {
		plain.WriteString(line)
		if i < len(lines)-1 || finalNewline {
			plain.WriteByte('\n')
		}
	}
	return gzipBytes(t, plain.Bytes())
}

func encodeRaw(t *testing.T, raw string) []byte {
	t.Helper()
	return gzipBytes(t, []byte(raw))
}

func gzipBytes(t *testing.T, raw []byte) []byte {
	t.Helper()
	var compressed bytes.Buffer
	zw := gzip.NewWriter(&compressed)
	if _, err := zw.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return compressed.Bytes()
}

func makeShard(t *testing.T, seq int64, schema string, lines ...string) shardPayload {
	t.Helper()
	payload := encodeLines(t, lines, true)
	return shardPayload{
		shard: Shard{
			Sequence:      seq,
			Digest:        SHA256Digest(payload),
			LineCount:     int64(len(lines)),
			SchemaVersion: schema,
		},
		payload: payload,
	}
}

func manifestOf(schema string, shards ...shardPayload) Manifest {
	m := Manifest{SchemaVersion: schema}
	for _, s := range shards {
		m.Shards = append(m.Shards, s.shard)
	}
	return m
}

type fakeDownloader struct {
	mu sync.Mutex

	payloads map[int64][]byte
	errs     map[int64]error
	calls    map[int64]int
	delays   map[int64]time.Duration

	active    int
	maxActive int
	before    func(context.Context, Shard)
}

func newFakeDownloader(payloads ...shardPayload) *fakeDownloader {
	d := &fakeDownloader{
		payloads: make(map[int64][]byte),
		errs:     make(map[int64]error),
		calls:    make(map[int64]int),
		delays:   make(map[int64]time.Duration),
	}
	for _, p := range payloads {
		d.payloads[p.shard.Sequence] = p.payload
	}
	return d
}

func (d *fakeDownloader) Download(ctx context.Context, shard Shard) (io.ReadCloser, error) {
	d.mu.Lock()
	d.calls[shard.Sequence]++
	d.active++
	if d.active > d.maxActive {
		d.maxActive = d.active
	}
	payload, hasPayload := d.payloads[shard.Sequence]
	err := d.errs[shard.Sequence]
	delay := d.delays[shard.Sequence]
	before := d.before
	d.mu.Unlock()

	defer func() {
		d.mu.Lock()
		d.active--
		d.mu.Unlock()
	}()

	if before != nil {
		before(ctx, shard)
	}
	if delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-timer.C:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if err != nil {
		return nil, err
	}
	if !hasPayload {
		return nil, errors.New("no payload")
	}
	return io.NopCloser(bytes.NewReader(payload)), nil
}

func (d *fakeDownloader) Calls(seq int64) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls[seq]
}

func (d *fakeDownloader) MaxActive() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.maxActive
}

func (d *fakeDownloader) setErr(seq int64, err error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.errs[seq] = err
}

func (d *fakeDownloader) setDelay(seq int64, delay time.Duration) {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.delays[seq] = delay
}

func readRecords(t *testing.T, reader *Reader) []string {
	t.Helper()
	var got []string
	for {
		rec, err := reader.Next()
		if err == io.EOF {
			return got
		}
		if err != nil {
			t.Fatalf("Next: %v", err)
		}
		got = append(got, fmt.Sprintf("%d/%d/%s/%s", rec.Sequence, rec.Line, rec.SchemaVersion, rec.Data))
	}
}
