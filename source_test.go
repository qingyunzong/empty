package forward

import (
	"context"
	"errors"
	"io"
	"testing"
)

// chunkReader turns a scripted chunk list into an io.Reader, including
// empty chunks via (0, nil) reads.
type chunkReader struct {
	chunks [][]byte
	pos    int
}

func (r *chunkReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.chunks) {
		return 0, io.EOF
	}
	n := copy(p, r.chunks[r.pos])
	r.pos++
	return n, nil
}

func TestReaderSourceEmptyChunks(t *testing.T) {
	r := &chunkReader{chunks: [][]byte{[]byte("a"), {}, []byte("bc"), {}}}
	d := newRecorder("d")

	res := New(Config{ChunkSize: 8}).Forward(context.Background(), NewReaderSource(r), d)

	if res.State != StateDelivered {
		t.Fatalf("state=%v err=%v", res.State, res.Err)
	}
	if res.Stats.BytesRead != 3 || res.Stats.ChunksRead != 4 {
		t.Fatalf("upstream account: %+v", res.Stats)
	}
	if res.Dests[0].ChunksWritten != 4 || res.Dests[0].BytesWritten != 3 {
		t.Fatalf("dest account: %+v", res.Dests[0])
	}
	if len(d.chunks) != 4 || len(d.chunks[1]) != 0 || len(d.chunks[3]) != 0 {
		t.Fatalf("empty chunks not forwarded: %q", d.chunks)
	}
}

// TestReaderSourceClosesUpstreamOnLimit verifies that once the limit trips
// the upstream writer observes the close immediately.
func TestReaderSourceClosesUpstreamOnLimit(t *testing.T) {
	pr, pw := io.Pipe()
	writeErrs := make(chan error, 3)
	go func() {
		for _, c := range []string{"aaaa", "bbbb", "cccc"} {
			_, err := pw.Write([]byte(c))
			writeErrs <- err
			if err != nil {
				return
			}
		}
	}()

	d := newRecorder("d")
	res := New(Config{ChunkSize: 4, MaxBytes: 5}).Forward(context.Background(), NewReaderSource(pr), d)

	if res.State != StateLimitExceeded || !errors.Is(res.Err, ErrLimitExceeded) {
		t.Fatalf("state=%v err=%v", res.State, res.Err)
	}
	if res.Stats.BytesRead != 8 || res.Dests[0].BytesWritten != 4 {
		t.Fatalf("accounts: read=%d written=%d", res.Stats.BytesRead, res.Dests[0].BytesWritten)
	}
	if err := <-writeErrs; err != nil {
		t.Fatalf("first write: %v", err)
	}
	if err := <-writeErrs; err != nil {
		t.Fatalf("second write: %v", err)
	}
	if err := <-writeErrs; !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("third write should hit closed upstream, got %v", err)
	}
}
