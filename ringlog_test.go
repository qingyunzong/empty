package ringlog

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func payload(b byte, n int) []byte { return bytes.Repeat([]byte{b}, n) }

func writeAll(t *testing.T, l *Logger, frames [][]byte) {
	t.Helper()
	for i, f := range frames {
		if err := l.Write(f); err != nil {
			t.Fatalf("write frame %d: %v", i, err)
		}
	}
}

func readAll(t *testing.T, l *Logger) [][]byte {
	t.Helper()
	r := l.NewReader()
	defer r.Close()
	var out [][]byte
	for {
		f, err := r.Next()
		if errors.Is(err, io.EOF) {
			return out
		}
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		out = append(out, f)
	}
}

func wantFrames(t *testing.T, got, want [][]byte) {
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

func create(t *testing.T, numPages uint32) (*Logger, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "ring.log")
	l, err := Create(path, numPages)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return l, path
}

func reopen(t *testing.T, l *Logger, path string) *Logger {
	t.Helper()
	if err := l.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	return openPath(t, path)
}

func openPath(t *testing.T, path string) *Logger {
	t.Helper()
	l2, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return l2
}

func TestRoundtrip(t *testing.T) {
	l, _ := create(t, 4)
	frames := [][]byte{[]byte("alpha"), []byte("beta"), payload(7, 100), {}}
	writeAll(t, l, frames)
	wantFrames(t, readAll(t, l), frames)
}

// Failure point: a frame larger than one page payload spans 3 pages.
func TestFrameSpansMultiplePages(t *testing.T) {
	l, path := create(t, 4)
	big := payload(0x5a, 9000) // 9000 > 2*4064, spans 3 pages
	frames := [][]byte{[]byte("head"), big, []byte("tail")}
	writeAll(t, l, frames)
	wantFrames(t, readAll(t, l), frames)

	l = reopen(t, l, path)
	defer l.Close()
	wantFrames(t, readAll(t, l), frames)
}

// Failure point: the 8-byte frame header straddles a page boundary.
func TestFrameHeaderStraddlesPageBoundary(t *testing.T) {
	l, path := create(t, 4)
	// rec(f1) = 8 + 4052 = 4060, so f2's header starts 4 bytes before
	// the end of page 0 and finishes on page 1.
	f1 := payload(0xa1, pagePayloadCap-frameHeaderSize-4)
	f2 := payload(0xb2, 100)
	f3 := payload(0xc3, 10)
	frames := [][]byte{f1, f2, f3}
	writeAll(t, l, frames)
	wantFrames(t, readAll(t, l), frames)

	l = reopen(t, l, path)
	defer l.Close()
	wantFrames(t, readAll(t, l), frames)
}

// Failure point: wraparound. Frames lapped by the writer are dropped;
// only frames whose start page is still intact remain readable.
func TestWraparoundDropsLappedFrames(t *testing.T) {
	l, _ := create(t, 3)
	var frames [][]byte
	for i := 0; i < 6; i++ {
		frames = append(frames, payload(byte(i+1), 3000))
	}
	writeAll(t, l, frames)
	if l.gen != 2 {
		t.Fatalf("gen = %d, want 2", l.gen)
	}
	// f1..f3's start pages have been lapped; f4..f6 survive.
	wantFrames(t, readAll(t, l), frames[3:])
}

// Failure point: the writer needs a page a reader is holding.
func TestBackpressureOnPinnedPage(t *testing.T) {
	l, _ := create(t, 3)
	defer l.Close()
	var frames [][]byte
	for i := 0; i < 4; i++ {
		frames = append(frames, payload(byte(i+1), 3000))
	}
	writeAll(t, l, frames)

	r := l.NewReader() // pins page 0
	defer r.Close()

	f5 := payload(9, 3000) // needs page 0 (wrap)
	if err := l.Write(f5); !errors.Is(err, ErrBackpressure) {
		t.Fatalf("write over pinned page: got %v, want ErrBackpressure", err)
	}
	if err := l.Write(f5); !errors.Is(err, ErrBackpressure) {
		t.Fatalf("retry while pinned: got %v, want ErrBackpressure", err)
	}
	if err := r.Close(); err != nil {
		t.Fatalf("reader close: %v", err)
	}
	if err := l.Write(f5); err != nil {
		t.Fatalf("write after release: %v", err)
	}
	// f1, f2 started on lapped page 0; f3, f4, f5 survive.
	wantFrames(t, readAll(t, l), [][]byte{frames[2], frames[3], f5})
}

// Clean close + reopen must preserve every frame.
func TestRecoverClean(t *testing.T) {
	l, path := create(t, 5)
	frames := [][]byte{
		[]byte("hello"),
		payload(0x11, 9000), // spans pages
		payload(0x22, pagePayloadCap-frameHeaderSize-4), // next header straddles
		payload(0x33, 100),
		{}, // zero-length frame
	}
	writeAll(t, l, frames)
	l = reopen(t, l, path)
	wantFrames(t, readAll(t, l), frames)

	more := payload(0x44, 5000)
	if err := l.Write(more); err != nil {
		t.Fatalf("write after reopen: %v", err)
	}
	l = reopen(t, l, path)
	defer l.Close()
	wantFrames(t, readAll(t, l), append(frames, more))
}

// Failure point: crash in the middle of writing a frame tail.
// Recovery must restore the last complete prefix.
func TestRecoverTornFrameTail(t *testing.T) {
	writeTail := func(t *testing.T, path string, tail []byte, plen uint32) {
		f, err := os.OpenFile(path, os.O_WRONLY, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if _, err := f.WriteAt(tail, pageHeaderSize+26); err != nil {
			t.Fatal(err)
		}
		var hdr [pageHeaderSize]byte
		encodePageHeader(hdr[:], 1, 0, plen, 0)
		if _, err := f.WriteAt(hdr[:], 0); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("PartialFrameHeader", func(t *testing.T) {
		l, path := create(t, 3)
		writeAll(t, l, [][]byte{[]byte("hello"), []byte("world")})
		if err := l.Close(); err != nil {
			t.Fatal(err)
		}
		// Crash after 5 bytes of an 8-byte frame header.
		writeTail(t, path, []byte{1, 2, 3, 4, 5}, 26+5)
		l = openPath(t, path)
		defer l.Close()
		wantFrames(t, readAll(t, l), [][]byte{[]byte("hello"), []byte("world")})
	})

	t.Run("PartialPayload", func(t *testing.T) {
		l, path := create(t, 3)
		writeAll(t, l, [][]byte{[]byte("hello"), []byte("world")})
		if err := l.Close(); err != nil {
			t.Fatal(err)
		}
		// Crash after a full header but only 30 of 100 payload bytes.
		tail := make([]byte, 8+30)
		binary.LittleEndian.PutUint32(tail[0:4], 100)
		binary.LittleEndian.PutUint32(tail[4:8], 0xdeadbeef)
		writeTail(t, path, tail, 26+8+30)
		l = openPath(t, path)
		defer l.Close()
		wantFrames(t, readAll(t, l), [][]byte{[]byte("hello"), []byte("world")})
	})
}

// Failure point: torn page header. The contiguous run stops at the
// bad page; recovery resumes at the first frame start after it.
func TestRecoverTornPageHeader(t *testing.T) {
	l, path := create(t, 4)
	var frames [][]byte
	for i := 0; i < 5; i++ {
		frames = append(frames, payload(byte(i+1), 3000))
	}
	writeAll(t, l, frames)
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}

	f, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteAt(make([]byte, pageHeaderSize), PageSize); err != nil { // corrupt page 1 header
		t.Fatal(err)
	}
	f.Close()

	l = openPath(t, path)
	// Pages 0..1 are lost; f4 starts page 2, f5 spans pages 2..3.
	wantFrames(t, readAll(t, l), frames[3:])

	// The logger must stay usable and recoverable afterwards.
	f6 := payload(0xee, 100)
	if err := l.Write(f6); err != nil {
		t.Fatalf("write after recovery: %v", err)
	}
	l = reopen(t, l, path)
	defer l.Close()
	wantFrames(t, readAll(t, l), [][]byte{frames[3], frames[4], f6})
}

// Failure point: recovery after wraparound must use generation
// numbers to exclude stale pages from previous laps.
func TestRecoverAfterWraparound(t *testing.T) {
	l, path := create(t, 3)
	var frames [][]byte
	for i := 0; i < 6; i++ {
		frames = append(frames, payload(byte(i+1), 3000))
	}
	writeAll(t, l, frames)
	l = reopen(t, l, path)
	defer l.Close()
	if l.gen != 2 {
		t.Fatalf("recovered gen = %d, want 2", l.gen)
	}
	wantFrames(t, readAll(t, l), frames[3:])
}

// Failure point: a bit-flipped frame payload mid-stream truncates
// the recovered prefix at that frame.
func TestRecoverCorruptFrameTruncatesPrefix(t *testing.T) {
	l, path := create(t, 3)
	writeAll(t, l, [][]byte{[]byte("aaa"), []byte("bbb"), []byte("ccc")})
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}

	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	// f2's payload sits at page 0 payload offset 8+3+8 = 19.
	buf := []byte{0}
	if _, err := f.ReadAt(buf, pageHeaderSize+19); err != nil {
		t.Fatal(err)
	}
	buf[0] ^= 0xff
	if _, err := f.WriteAt(buf, pageHeaderSize+19); err != nil {
		t.Fatal(err)
	}
	f.Close()

	l = openPath(t, path)
	wantFrames(t, readAll(t, l), [][]byte{[]byte("aaa")})

	// New writes reuse the torn region and stay recoverable.
	if err := l.Write([]byte("ddd")); err != nil {
		t.Fatalf("write after recovery: %v", err)
	}
	l = reopen(t, l, path)
	defer l.Close()
	wantFrames(t, readAll(t, l), [][]byte{[]byte("aaa"), []byte("ddd")})
}

// Failure point: a page the reader is about to enter was overwritten
// by a newer generation.
func TestReaderDetectsGenerationOverwrite(t *testing.T) {
	l, _ := create(t, 3)
	defer l.Close()
	writeAll(t, l, [][]byte{payload(1, 3000), payload(2, 3000)})

	r := l.NewReader()
	defer r.Close()
	if _, err := r.Next(); err != nil {
		t.Fatalf("first frame: %v", err)
	}
	// Simulate the writer lapping page 1 behind the reader's back
	// (white-box: rewrite page 1's header with a newer generation).
	var hdr [pageHeaderSize]byte
	encodePageHeader(hdr[:], 2, 1, 0, noFrame)
	if _, err := l.f.WriteAt(hdr[:], PageSize); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Next(); !errors.Is(err, ErrDataLost) {
		t.Fatalf("got %v, want ErrDataLost", err)
	}
}

func TestFrameTooLarge(t *testing.T) {
	l, _ := create(t, 3)
	defer l.Close()
	if err := l.Write(payload(1, 2*pagePayloadCap-frameHeaderSize+1)); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("got %v, want ErrFrameTooLarge", err)
	}
	big := payload(2, 2*pagePayloadCap-frameHeaderSize) // exactly fits
	if err := l.Write(big); err != nil {
		t.Fatalf("max-size frame: %v", err)
	}
	wantFrames(t, readAll(t, l), [][]byte{big})
}

func TestReaderObservesNewWrites(t *testing.T) {
	l, _ := create(t, 3)
	defer l.Close()
	if err := l.Write([]byte("one")); err != nil {
		t.Fatal(err)
	}
	r := l.NewReader()
	defer r.Close()
	got, err := r.Next()
	if err != nil || string(got) != "one" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := r.Next(); !errors.Is(err, io.EOF) {
		t.Fatalf("got %v, want EOF", err)
	}
	if err := l.Write([]byte("two")); err != nil {
		t.Fatal(err)
	}
	got, err = r.Next()
	if err != nil || string(got) != "two" {
		t.Fatalf("got %q, %v", got, err)
	}
}

// Concurrent readers and writer: backpressure must prevent any data
// loss, so each reader sees every frame.
func TestConcurrentReadWrite(t *testing.T) {
	l, _ := create(t, 8)
	defer l.Close()
	const total = 500

	var wg sync.WaitGroup
	errs := make(chan error, 3)

	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < total; i++ {
			f := payload(byte(i), 100+i%200)
			for {
				err := l.Write(f)
				if errors.Is(err, ErrBackpressure) {
					continue
				}
				if err != nil {
					errs <- err
					return
				}
				break
			}
		}
	}()

	reader := func() {
		defer wg.Done()
		r := l.NewReader()
		defer r.Close()
		seen := 0
		for seen < total {
			_, err := r.Next()
			if errors.Is(err, io.EOF) {
				continue
			}
			if err != nil {
				errs <- err
				return
			}
			seen++
		}
	}
	wg.Add(2)
	go reader()
	go reader()

	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent error: %v", err)
	}
}
