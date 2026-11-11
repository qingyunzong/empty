package q210

import (
	"bytes"
	"compress/gzip"
	"compress/zlib"
	"context"
	"errors"
	"io"
	"math/rand"
	"os"
	"strings"
	"sync"
	"testing"
)

type memStore struct {
	mu       sync.Mutex
	payloads [][]byte
}

func (m *memStore) Commit(_ context.Context, p []byte) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.payloads = append(m.payloads, append([]byte(nil), p...))
	return nil
}

func (m *memStore) commits() [][]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([][]byte(nil), m.payloads...)
}

type trackedBody struct {
	r      io.Reader
	onRead func()
	closed bool
}

func (t *trackedBody) Read(p []byte) (int, error) {
	if t.onRead != nil {
		t.onRead()
	}
	return t.r.Read(p)
}

func (t *trackedBody) Close() error {
	t.closed = true
	return nil
}

func gzipMember(t *testing.T, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func deflateBytes(t *testing.T, data []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zlib.NewWriter(&buf)
	if _, err := zw.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func run(t *testing.T, body io.ReadCloser, chain []string, lim Limits) (*memStore, error) {
	t.Helper()
	st := &memStore{}
	err := Process(context.Background(), body, chain, lim, st)
	return st, err
}

func TestNestedChainRoundTrip(t *testing.T) {
	payload := []byte(strings.Repeat("collector-payload-", 64))
	inner := gzipMember(t, payload)
	middle := deflateBytes(t, inner)
	outer := gzipMember(t, middle)

	st, err := run(t, io.NopCloser(bytes.NewReader(outer)),
		[]string{"gzip", "deflate", "gzip"},
		Limits{
			Layers: []int64{int64(len(payload)), int64(len(inner)), int64(len(middle))},
			Total:  int64(len(payload)),
		})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	got := st.commits()
	if len(got) != 1 {
		t.Fatalf("expected exactly one commit, got %d", len(got))
	}
	if !bytes.Equal(got[0], payload) {
		t.Fatalf("payload mismatch: got %d bytes, want %d", len(got[0]), len(payload))
	}
}

func TestExactLimitAllowed(t *testing.T) {
	payload := []byte("exactly-at-the-limit")
	body := gzipMember(t, payload)

	st, err := run(t, io.NopCloser(bytes.NewReader(body)),
		[]string{"gzip"},
		Limits{Layers: []int64{int64(len(payload))}, Total: int64(len(payload))})
	if err != nil {
		t.Fatalf("exact limit must be allowed: %v", err)
	}
	if got := st.commits(); len(got) != 1 || !bytes.Equal(got[0], payload) {
		t.Fatalf("unexpected commits: %v", got)
	}
}

func TestOneByteOverLimitTerminates(t *testing.T) {
	payload := []byte("one-byte-over")
	body := gzipMember(t, payload)

	cases := map[string]Limits{
		"layer limit": {Layers: []int64{int64(len(payload) - 1)}, Total: int64(len(payload))},
		"total limit": {Layers: []int64{int64(len(payload))}, Total: int64(len(payload) - 1)},
	}
	for name, lim := range cases {
		t.Run(name, func(t *testing.T) {
			st, err := run(t, io.NopCloser(bytes.NewReader(body)), []string{"gzip"}, lim)
			if !errors.Is(err, ErrLimitExceeded) {
				t.Fatalf("expected ErrLimitExceeded, got %v", err)
			}
			if got := st.commits(); len(got) != 0 {
				t.Fatalf("no commit expected, got %d", len(got))
			}
		})
	}
}

func TestConcatenatedGzipMembers(t *testing.T) {
	body := append(gzipMember(t, []byte("hello, ")), gzipMember(t, []byte("world"))...)

	st, err := run(t, io.NopCloser(bytes.NewReader(body)),
		[]string{"gzip"},
		Limits{Layers: []int64{64}, Total: 64})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	got := st.commits()
	if len(got) != 1 || string(got[0]) != "hello, world" {
		t.Fatalf("unexpected commits: %q", got)
	}
}

func TestZeroPaddingTolerated(t *testing.T) {
	payload := []byte("padded")
	body := append(gzipMember(t, payload), 0, 0, 0, 0)

	st, err := run(t, io.NopCloser(bytes.NewReader(body)),
		[]string{"gzip"},
		Limits{Layers: []int64{64}, Total: 64})
	if err != nil {
		t.Fatalf("zero padding must be tolerated: %v", err)
	}
	if got := st.commits(); len(got) != 1 || !bytes.Equal(got[0], payload) {
		t.Fatalf("unexpected commits: %q", got)
	}
}

func TestTrailingGarbageRejected(t *testing.T) {
	payload := []byte("data")

	t.Run("gzip", func(t *testing.T) {
		body := append(gzipMember(t, payload), "garbage"...)
		st, err := run(t, io.NopCloser(bytes.NewReader(body)),
			[]string{"gzip"},
			Limits{Layers: []int64{64}, Total: 64})
		if err == nil {
			t.Fatal("expected error for trailing garbage")
		}
		if got := st.commits(); len(got) != 0 {
			t.Fatalf("no commit expected, got %d", len(got))
		}
	})

	t.Run("deflate", func(t *testing.T) {
		body := append(deflateBytes(t, payload), 0, 0, 0x01)
		st, err := run(t, io.NopCloser(bytes.NewReader(body)),
			[]string{"deflate"},
			Limits{Layers: []int64{64}, Total: 64})
		if !errors.Is(err, ErrTrailingData) {
			t.Fatalf("expected ErrTrailingData, got %v", err)
		}
		if got := st.commits(); len(got) != 0 {
			t.Fatalf("no commit expected, got %d", len(got))
		}
	})
}

func TestCorruptedChecksumRejected(t *testing.T) {
	payload := []byte("checksum-me")

	t.Run("gzip", func(t *testing.T) {
		body := gzipMember(t, payload)
		body[len(body)-5] ^= 0xff // corrupt CRC32 in trailer
		st, err := run(t, io.NopCloser(bytes.NewReader(body)),
			[]string{"gzip"},
			Limits{Layers: []int64{64}, Total: 64})
		if !errors.Is(err, gzip.ErrChecksum) {
			t.Fatalf("expected gzip.ErrChecksum, got %v", err)
		}
		if got := st.commits(); len(got) != 0 {
			t.Fatalf("no commit expected, got %d", len(got))
		}
	})

	t.Run("deflate", func(t *testing.T) {
		body := deflateBytes(t, payload)
		body[len(body)-1] ^= 0xff // corrupt Adler-32
		st, err := run(t, io.NopCloser(bytes.NewReader(body)),
			[]string{"deflate"},
			Limits{Layers: []int64{64}, Total: 64})
		if !errors.Is(err, zlib.ErrChecksum) {
			t.Fatalf("expected zlib.ErrChecksum, got %v", err)
		}
		if got := st.commits(); len(got) != 0 {
			t.Fatalf("no commit expected, got %d", len(got))
		}
	})
}

func TestTruncatedStreamRejected(t *testing.T) {
	payload := []byte(strings.Repeat("truncate-me-", 32))
	body := gzipMember(t, payload)
	body = body[:len(body)/2]

	st, err := run(t, io.NopCloser(bytes.NewReader(body)),
		[]string{"gzip"},
		Limits{Layers: []int64{1 << 20}, Total: 1 << 20})
	if !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("expected io.ErrUnexpectedEOF, got %v", err)
	}
	if got := st.commits(); len(got) != 0 {
		t.Fatalf("no commit expected, got %d", len(got))
	}
}

func TestCancelClosesBodyAndReclaimsStaging(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)

	payload := make([]byte, 1<<18)
	rnd := rand.New(rand.NewSource(42))
	if _, err := rnd.Read(payload); err != nil {
		t.Fatal(err)
	}
	compressed := gzipMember(t, payload)

	ctx, cancel := context.WithCancel(context.Background())
	body := &trackedBody{r: bytes.NewReader(compressed), onRead: cancel}

	st := &memStore{}
	err := Process(ctx, body, []string{"gzip"},
		Limits{Layers: []int64{1 << 20}, Total: 1 << 20}, st)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	if !body.closed {
		t.Fatal("bottom-most body was not closed on cancel")
	}
	if got := st.commits(); len(got) != 0 {
		t.Fatalf("no commit expected after cancel, got %d", len(got))
	}
	entries, err := os.ReadDir(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("staging not reclaimed: %d entries left", len(entries))
	}
}

func TestDecompressionBombStaysBounded(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)

	compressed := gzipMember(t, make([]byte, 4<<20)) // ~4 MB of zeros
	if len(compressed) > 1<<16 {
		t.Fatalf("test premise broken: bomb is %d bytes", len(compressed))
	}

	st, err := run(t, io.NopCloser(bytes.NewReader(compressed)),
		[]string{"gzip"},
		Limits{Layers: []int64{64 << 10}, Total: 64 << 10})
	if !errors.Is(err, ErrLimitExceeded) {
		t.Fatalf("expected ErrLimitExceeded, got %v", err)
	}
	if got := st.commits(); len(got) != 0 {
		t.Fatalf("no commit expected, got %d", len(got))
	}
	entries, err := os.ReadDir(tmp)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("staging not reclaimed: %d entries left", len(entries))
	}
}

func TestTooManyLayersRejected(t *testing.T) {
	chain := []string{"gzip", "gzip", "gzip", "gzip"}
	st, err := run(t, io.NopCloser(strings.NewReader("x")), chain,
		Limits{Layers: []int64{1, 1, 1, 1}, Total: 1})
	if !errors.Is(err, ErrTooManyLayers) {
		t.Fatalf("expected ErrTooManyLayers, got %v", err)
	}
	if got := st.commits(); len(got) != 0 {
		t.Fatalf("no commit expected, got %d", len(got))
	}
}

func TestUnknownEncodingRejected(t *testing.T) {
	st, err := run(t, io.NopCloser(strings.NewReader("x")),
		[]string{"br"},
		Limits{Layers: []int64{1}, Total: 1})
	if !errors.Is(err, ErrBadEncoding) {
		t.Fatalf("expected ErrBadEncoding, got %v", err)
	}
	if got := st.commits(); len(got) != 0 {
		t.Fatalf("no commit expected, got %d", len(got))
	}
}

func TestIdentityLayer(t *testing.T) {
	payload := []byte("plain-body")
	st, err := run(t, io.NopCloser(bytes.NewReader(payload)),
		[]string{"identity"},
		Limits{Layers: []int64{int64(len(payload))}, Total: int64(len(payload))})
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if got := st.commits(); len(got) != 1 || !bytes.Equal(got[0], payload) {
		t.Fatalf("unexpected commits: %q", got)
	}
}

func TestBodyClosedOnSuccess(t *testing.T) {
	payload := []byte("close-me")
	body := &trackedBody{r: bytes.NewReader(gzipMember(t, payload))}

	st := &memStore{}
	err := Process(context.Background(), body, []string{"gzip"},
		Limits{Layers: []int64{64}, Total: 64}, st)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if !body.closed {
		t.Fatal("body was not closed")
	}
}
