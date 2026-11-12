package dataeng

import (
	"bytes"
	"context"
	"io"
	"math/rand"
	"testing"
)

// randomChunkReader 用随机切块宽度返回数据，模拟任意分块到达节奏。
type randomChunkReader struct {
	data []byte
	pos  int
	rng  *rand.Rand
}

func (r *randomChunkReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.data) {
		return 0, io.EOF
	}
	max := r.rng.Intn(7) + 1
	if max > len(p) {
		max = len(p)
	}
	if max > len(r.data)-r.pos {
		max = len(r.data) - r.pos
	}
	copy(p, r.data[r.pos:r.pos+max])
	r.pos += max
	return max, nil
}

func (r *randomChunkReader) Close() error { return nil }

func TestRandomChunkFuzz(t *testing.T) {
	boundary := "Fz7Q"
	parts := []partSpec{
		{headers: []Header{{Name: "Content-ID", Value: "1"}}, body: []byte("")},
		{headers: []Header{{Name: "X", Value: "y"}}, body: []byte("some body with --Fz7 fake\r\nboundaries")},
		{headers: nil, body: []byte("third")},
	}
	want := buildMessage(boundary, parts)

	for seed := int64(0); seed < 200; seed++ {
		rng := rand.New(rand.NewSource(seed))
		in := &randomChunkReader{data: want, rng: rng}
		sink := &memSink{beginErrAt: -1, writerErrAt: -1}
		n, err := Parse(context.Background(), in, boundary, testLimits, sink)
		if err != nil {
			t.Fatalf("seed=%d Parse: %v", seed, err)
		}
		if n != len(parts) {
			t.Fatalf("seed=%d n=%d want %d", seed, n, len(parts))
		}
		for i, sp := range parts {
			if !bytes.Equal(sink.parts[i].body, sp.body) {
				t.Fatalf("seed=%d part %d body=%q want %q", seed, i, sink.parts[i].body, sp.body)
			}
		}
	}
}
