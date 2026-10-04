package canonenc

import (
	"bytes"
	"errors"
	"math/rand"
	"testing"
)

// decodeInChunks feeds enc through a streaming Decoder using the given
// chunk sizes (cycled), collecting all decoded output.
func decodeInChunks(t *testing.T, enc []byte, sizes []int) ([]byte, error) {
	t.Helper()
	d := NewDecoder()
	var out []byte
	pos, si := 0, 0
	for pos < len(enc) {
		n := sizes[si%len(sizes)]
		si++
		if n <= 0 {
			n = 1
		}
		if pos+n > len(enc) {
			n = len(enc) - pos
		}
		chunk, err := d.Write(enc[pos : pos+n])
		if err != nil {
			return nil, err
		}
		out = append(out, chunk...)
		pos += n
	}
	if err := d.Finalize(); err != nil {
		return nil, err
	}
	return out, nil
}

// TestStreamEverySplitPoint decodes the same encoding split into two
// chunks at every possible split point, including points inside escape
// sequences.
func TestStreamEverySplitPoint(t *testing.T) {
	src := allBytes()
	enc := EncodeString(src)
	for split := 0; split <= len(enc); split++ {
		got, err := decodeInChunks(t, enc, []int{split, len(enc) - split})
		if err != nil {
			t.Fatalf("split %d: %v", split, err)
		}
		if !bytes.Equal(got, src) {
			t.Fatalf("split %d: decoded output mismatch", split)
		}
	}
}

// TestStreamArbitraryChunking decodes with pseudo-random chunk sizes,
// including chunks of size 1 that split every escape sequence.
func TestStreamArbitraryChunking(t *testing.T) {
	src := allBytes()
	enc := EncodeString(src)
	for _, sizes := range [][]int{{1}, {2}, {3}, {1, 2, 3, 4, 5}, {7, 1, 13}} {
		got, err := decodeInChunks(t, enc, sizes)
		if err != nil {
			t.Fatalf("chunk sizes %v: %v", sizes, err)
		}
		if !bytes.Equal(got, src) {
			t.Fatalf("chunk sizes %v: decoded output mismatch", sizes)
		}
	}
	rng := rand.New(rand.NewSource(42))
	for trial := 0; trial < 200; trial++ {
		sizes := make([]int, 1+rng.Intn(8))
		for i := range sizes {
			sizes[i] = 1 + rng.Intn(11)
		}
		got, err := decodeInChunks(t, enc, sizes)
		if err != nil {
			t.Fatalf("trial %d sizes %v: %v", trial, sizes, err)
		}
		if !bytes.Equal(got, src) {
			t.Fatalf("trial %d sizes %v: mismatch", trial, sizes)
		}
	}
}

// TestStreamDoubleEncoded feeds a double-encoded payload through the
// streaming decoder one byte at a time, then decodes the result again.
func TestStreamDoubleEncoded(t *testing.T) {
	src := []byte("%already%0Aencoded%\n")
	twice := EncodeString(EncodeString(src))
	got, err := decodeInChunks(t, twice, []int{1})
	if err != nil {
		t.Fatalf("stream decode: %v", err)
	}
	back, err := DecodeString(got)
	if err != nil {
		t.Fatalf("second decode: %v", err)
	}
	if !bytes.Equal(back, src) {
		t.Fatalf("double-encoded stream round trip mismatch: got %q", back)
	}
}

// TestStreamTruncationVsInvalid checks the streaming decoder's core
// distinction: a stream cut off inside an escape is incomplete, while a
// stream containing a bad escape is invalid — even when the bad byte
// arrives in a later chunk than the '%' that opened the escape.
func TestStreamTruncationVsInvalid(t *testing.T) {
	// Truncation: "%0" then end of stream.
	d := NewDecoder()
	if _, err := d.Write([]byte("abc%0")); err != nil {
		t.Fatalf("write of partial escape: unexpected error %v", err)
	}
	if err := d.Finalize(); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("Finalize after truncation = %v, want ErrIncomplete", err)
	}
	if errors.Is(d.Finalize(), ErrInvalid) {
		t.Fatal("truncation misreported as ErrInvalid")
	}

	// Invalid escape digit arriving in the chunk after '%'.
	d = NewDecoder()
	if _, err := d.Write([]byte("abc%")); err != nil {
		t.Fatalf("write of lone percent: unexpected error %v", err)
	}
	if _, err := d.Write([]byte("ZZ")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("write of bad digits = %v, want ErrInvalid", err)
	}

	// Non-canonical escape completed across a chunk boundary.
	d = NewDecoder()
	if _, err := d.Write([]byte("%4")); err != nil {
		t.Fatalf("write of partial: unexpected error %v", err)
	}
	if _, err := d.Write([]byte("1")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("completion with non-canonical escape = %v, want ErrInvalid", err)
	}

	// Lowercase hex completed across a chunk boundary.
	d = NewDecoder()
	if _, err := d.Write([]byte("%0")); err != nil {
		t.Fatalf("write of partial: unexpected error %v", err)
	}
	if _, err := d.Write([]byte("a")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("completion with lowercase hex = %v, want ErrInvalid", err)
	}

	// After an error the decoder stays failed until Reset.
	if _, err := d.Write([]byte("ok")); !errors.Is(err, ErrInvalid) {
		t.Fatalf("write after failure = %v, want ErrInvalid", err)
	}
	d.Reset()
	out, err := d.Write([]byte("fine"))
	if err != nil || string(out) != "fine" {
		t.Fatalf("after Reset: out=%q err=%v", out, err)
	}
	if err := d.Finalize(); err != nil {
		t.Fatalf("Finalize after Reset: %v", err)
	}
}

// TestStreamEmptyWrites ensures empty chunks are harmless.
func TestStreamEmptyWrites(t *testing.T) {
	d := NewDecoder()
	for i := 0; i < 3; i++ {
		if out, err := d.Write(nil); err != nil || len(out) != 0 {
			t.Fatalf("empty write: out=%q err=%v", out, err)
		}
	}
	if err := d.Finalize(); err != nil {
		t.Fatalf("Finalize on empty stream: %v", err)
	}
}
