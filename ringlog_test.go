package ringlog

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

const (
	testPages    = 4
	testPageSize = 64 // data capacity per page: 40 bytes
)

func openTestLogger(t *testing.T, dir string, numPages, pageSize int) (*Logger, string) {
	t.Helper()
	path := filepath.Join(dir, "ring.log")
	l, err := Open(path, numPages, pageSize)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return l, path
}

func reopen(t *testing.T, l *Logger, path string, numPages, pageSize int) *Logger {
	t.Helper()
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	nl, err := Open(path, numPages, pageSize)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	return nl
}

func readAll(t *testing.T, r *Reader) [][]byte {
	t.Helper()
	var out [][]byte
	for {
		p, err := r.Next()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatalf("Next: %v", err)
		}
		out = append(out, p)
	}
}

func payloadOf(b byte, n int) []byte { return bytes.Repeat([]byte{b}, n) }

func writeAll(t *testing.T, l *Logger, payloads ...[]byte) {
	t.Helper()
	for i, p := range payloads {
		if err := l.Write(p); err != nil {
			t.Fatalf("Write %d: %v", i, err)
		}
	}
}

func assertFrames(t *testing.T, got [][]byte, want ...[]byte) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d frames, want %d", len(got), len(want))
	}
	for i := range want {
		if !bytes.Equal(got[i], want[i]) {
			t.Fatalf("frame %d mismatch: got %d bytes, want %d", i, len(got[i]), len(want[i]))
		}
	}
}

// flipByte xors one byte in the file to simulate a torn/corrupt write.
func flipByte(t *testing.T, path string, off int64) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatalf("flipByte open: %v", err)
	}
	defer f.Close()
	b := []byte{0}
	if _, err := f.ReadAt(b, off); err != nil {
		t.Fatalf("flipByte read: %v", err)
	}
	b[0] ^= 0xff
	if _, err := f.WriteAt(b, off); err != nil {
		t.Fatalf("flipByte write: %v", err)
	}
}

func TestRoundTrip(t *testing.T) {
	l, _ := openTestLogger(t, t.TempDir(), testPages, testPageSize)
	defer l.Close()
	f1, f2, f3 := payloadOf('a', 5), payloadOf('b', 10), payloadOf('c', 1)
	writeAll(t, l, f1, f2, f3)
	r := l.NewReader()
	defer r.Close()
	assertFrames(t, readAll(t, r), f1, f2, f3)
	if _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestFrameSpansMultiplePages(t *testing.T) {
	l, path := openTestLogger(t, t.TempDir(), testPages, testPageSize)
	big := payloadOf('x', 100) // 112-byte frame over 3 pages (cap 40)
	writeAll(t, l, big)
	r := l.NewReader()
	assertFrames(t, readAll(t, r), big)
	r.Close()
	l = reopen(t, l, path, testPages, testPageSize)
	defer l.Close()
	r = l.NewReader()
	defer r.Close()
	assertFrames(t, readAll(t, r), big)
}

func TestFrameHeaderStraddlesPageBoundary(t *testing.T) {
	l, path := openTestLogger(t, t.TempDir(), testPages, testPageSize)
	f1 := payloadOf('a', 26) // 38 bytes: page 0 data left = 2 bytes
	f2 := payloadOf('b', 30) // 42 bytes: its 12-byte header straddles pages 0 and 1
	writeAll(t, l, f1, f2)
	l = reopen(t, l, path, testPages, testPageSize)
	defer l.Close()
	r := l.NewReader()
	defer r.Close()
	assertFrames(t, readAll(t, r), f1, f2)
}

func TestWrapAroundGeneration(t *testing.T) {
	l, path := openTestLogger(t, t.TempDir(), 3, testPageSize)
	f1 := payloadOf('1', 30)
	f2 := payloadOf('2', 30)
	f3 := payloadOf('3', 30)
	f4 := payloadOf('4', 30)
	f5 := payloadOf('5', 30)
	writeAll(t, l, f1, f2, f3, f4, f5) // 5*42 = 210 bytes in a 120-byte ring
	if l.gen != 1 {
		t.Fatalf("want generation 1 after wrap, got %d", l.gen)
	}
	// Only the frames still inside the live window survive.
	r := l.NewReader()
	assertFrames(t, readAll(t, r), f4, f5)
	r.Close()
	l = reopen(t, l, path, 3, testPageSize)
	defer l.Close()
	r = l.NewReader()
	defer r.Close()
	assertFrames(t, readAll(t, r), f4, f5)
}

func TestBackpressureOnPinnedPage(t *testing.T) {
	l, path := openTestLogger(t, t.TempDir(), 3, testPageSize)
	f1 := payloadOf('1', 30)
	f2 := payloadOf('2', 30)
	f3 := payloadOf('3', 30)
	writeAll(t, l, f1, f2) // f1: p0+p1[0:2], f2: p1[2:40]+p2[0:4]
	r := l.NewReader()     // pins page 0
	err := l.Write(f3)     // needs page 0 -> explicit backpressure, nothing written
	if !errors.Is(err, ErrBackpressure) {
		t.Fatalf("want ErrBackpressure, got %v", err)
	}
	// The pinned page is untouched: the reader still reads every frame.
	assertFrames(t, readAll(t, r), f1, f2)
	r.Close() // releases the pin
	writeAll(t, l, f3)
	l = reopen(t, l, path, 3, testPageSize)
	defer l.Close()
	// f1's header lived on overwritten page 0; f2 and f3 survive.
	r2 := l.NewReader()
	defer r2.Close()
	assertFrames(t, readAll(t, r2), f2, f3)
}

func TestFrameTooLarge(t *testing.T) {
	l, _ := openTestLogger(t, t.TempDir(), 2, testPageSize)
	defer l.Close()
	if err := l.Write(payloadOf('z', 100)); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("want ErrFrameTooLarge, got %v", err)
	}
}

func TestTornFrameTail(t *testing.T) {
	l, path := openTestLogger(t, t.TempDir(), testPages, testPageSize)
	f1 := payloadOf('a', 10)
	f2 := payloadOf('b', 10)
	f3 := payloadOf('c', 10)
	writeAll(t, l, f1, f2, f3) // 22-byte frames; f3 payload ends at page 1 offset 26
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Tear the tail: corrupt one payload byte of the last frame.
	flipByte(t, path, int64(1*testPageSize+HeaderSize+20))
	l, err := Open(path, testPages, testPageSize)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer l.Close()
	r := l.NewReader()
	defer r.Close()
	assertFrames(t, readAll(t, r), f1, f2) // last complete prefix
	// Writer resumes right after the last complete frame.
	if l.wpage != 1 || l.wused != 4 {
		t.Fatalf("resume at page %d off %d, want page 1 off 4", l.wpage, l.wused)
	}
}

func TestTornPageHeaderAtFrontier(t *testing.T) {
	l, path := openTestLogger(t, t.TempDir(), testPages, testPageSize)
	f1 := payloadOf('a', 30)
	f2 := payloadOf('b', 30)
	f3 := payloadOf('c', 30)
	writeAll(t, l, f1, f2, f3) // f3 spans pages 2..3
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Tear the header of the frontier page (page 3).
	flipByte(t, path, int64(3*testPageSize+4))
	l, err := Open(path, testPages, testPageSize)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer l.Close()
	r := l.NewReader()
	defer r.Close()
	assertFrames(t, readAll(t, r), f1, f2)
}

func TestTornPageHeaderMidStream(t *testing.T) {
	l, path := openTestLogger(t, t.TempDir(), testPages, testPageSize)
	f1 := payloadOf('a', 28) // exactly fills page 0
	f2 := payloadOf('b', 30) // header on torn page 1
	f3 := payloadOf('c', 30)
	f4 := payloadOf('d', 10)
	writeAll(t, l, f1, f2, f3, f4)
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	// Tear the header of page 1 (mid-stream hole).
	flipByte(t, path, int64(1*testPageSize+4))
	l, err := Open(path, testPages, testPageSize)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer l.Close()
	r := l.NewReader()
	defer r.Close()
	// f1 (complete prefix) survives; f2 is lost with its page; f3 and f4
	// are recovered by resynchronizing on the frame magic after the hole.
	assertFrames(t, readAll(t, r), f1, f3, f4)
}

func TestReaderSeesLiveWrites(t *testing.T) {
	l, _ := openTestLogger(t, t.TempDir(), testPages, testPageSize)
	defer l.Close()
	r := l.NewReader()
	defer r.Close()
	if _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("want EOF on empty log, got %v", err)
	}
	f1 := payloadOf('q', 7)
	writeAll(t, l, f1)
	assertFrames(t, readAll(t, r), f1)
}

func TestGeometryMismatch(t *testing.T) {
	dir := t.TempDir()
	l, path := openTestLogger(t, dir, testPages, testPageSize)
	l.Close()
	if _, err := Open(path, 8, testPageSize); err == nil {
		t.Fatal("want geometry mismatch error")
	}
}
