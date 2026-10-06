package blkarc

import (
	"bytes"
	"errors"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

func writeArchive(t *testing.T, path string, blockSize int, gens ...[]byte) (file []byte, indexOffsets []int64) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for i, data := range gens {
		var w *Writer
		if i == 0 {
			w, err = Create(f, blockSize)
		} else {
			w, err = Append(f)
		}
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(data); err != nil {
			t.Fatal(err)
		}
		off, err := w.Close()
		if err != nil {
			t.Fatal(err)
		}
		indexOffsets = append(indexOffsets, off)
	}
	file, err = os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return file, indexOffsets
}

func openFile(t *testing.T, path string) *os.File {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func readRange(t *testing.T, r *Reader, off, length int64) ([]byte, error) {
	t.Helper()
	return io.ReadAll(io.NewSectionReader(r, off, length))
}

func TestRandomSlices(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	data := make([]byte, 200_000)
	rng.Read(data)
	path := filepath.Join(t.TempDir(), "a.blk")
	writeArchive(t, path, 4096, data)

	r, err := Open(openFile(t, path))
	if err != nil {
		t.Fatal(err)
	}
	if r.Size() != int64(len(data)) {
		t.Fatalf("size = %d, want %d", r.Size(), len(data))
	}
	for i := 0; i < 500; i++ {
		off := rng.Int63n(int64(len(data)))
		length := rng.Int63n(int64(len(data))-off) + 1
		got, err := readRange(t, r, off, length)
		if err != nil {
			t.Fatalf("slice [%d:%d]: %v", off, off+length, err)
		}
		if !bytes.Equal(got, data[off:off+length]) {
			t.Fatalf("slice [%d:%d] mismatch", off, off+length)
		}
	}
	// Boundary reads.
	for _, off := range []int64{0, 1, int64(len(data)) - 1, int64(len(data))} {
		got, err := readRange(t, r, off, int64(len(data))-off)
		if err != nil || !bytes.Equal(got, data[off:]) {
			t.Fatalf("boundary read at %d: err=%v match=%v", off, err, bytes.Equal(got, data[off:]))
		}
	}
	if _, err := r.ReadAt(make([]byte, 1), int64(len(data))); err != io.EOF {
		t.Fatalf("read past end: err = %v, want EOF", err)
	}
	if err := r.Verify(); err != nil {
		t.Fatal(err)
	}
}

func TestCorruptBlockScopedFailure(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	data := make([]byte, 10*1024)
	rng.Read(data)
	path := filepath.Join(t.TempDir(), "a.blk")
	file, _ := writeArchive(t, path, 1024, data)

	r, err := Open(openFile(t, path))
	if err != nil {
		t.Fatal(err)
	}
	if r.NumBlocks() < 3 {
		t.Fatalf("need >= 3 blocks, got %d", r.NumBlocks())
	}
	// Corrupt one byte inside block 2's compressed payload.
	bad := 2
	off, compLen, _ := r.BlockSpan(bad)
	file[off+int64(compLen)/2] ^= 0xFF
	if err := os.WriteFile(path, file, 0o644); err != nil {
		t.Fatal(err)
	}

	r, err = Open(openFile(t, path))
	if err != nil {
		t.Fatal(err)
	}
	// Reads intersecting block 2 must fail with a BlockError.
	for _, ro := range []int64{int64(bad)*1024 - 1, int64(bad) * 1024, int64(bad+1)*1024 - 1} {
		_, err := readRange(t, r, ro, 2)
		var be *BlockError
		if !errors.As(err, &be) || be.Index != bad {
			t.Fatalf("read at %d: err = %v, want BlockError{Index:%d}", ro, err, bad)
		}
	}
	// Reads fully inside other blocks must still succeed.
	for _, ro := range []int64{0, 512, 3 * 1024, 9*1024 + 1000} {
		got, err := readRange(t, r, ro, 24)
		if err != nil || !bytes.Equal(got, data[ro:ro+24]) {
			t.Fatalf("disjoint read at %d: err=%v match=%v", ro, err, bytes.Equal(got, data[ro:ro+24]))
		}
	}
	// Whole-file verification must report the damage.
	if err := r.Verify(); err == nil {
		t.Fatal("Verify succeeded on corrupted archive")
	}
}

func TestCorruptIndexRejectsAll(t *testing.T) {
	data := bytes.Repeat([]byte("hello world "), 500)
	path := filepath.Join(t.TempDir(), "a.blk")
	file, idxOffs := writeArchive(t, path, 1024, data)
	idxOff := idxOffs[0]

	corrupt := func(pos int64, name string) {
		bad := bytes.Clone(file)
		bad[pos] ^= 0xFF
		p := filepath.Join(t.TempDir(), name)
		if err := os.WriteFile(p, bad, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := Open(openFile(t, p)); !errors.Is(err, ErrIndexCorrupt) {
			t.Fatalf("%s: Open err = %v, want ErrIndexCorrupt", name, err)
		}
		// Appending to a corrupt archive must also be refused.
		f, err := os.OpenFile(p, os.O_RDWR, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		if _, err := Append(f); !errors.Is(err, ErrIndexCorrupt) {
			t.Fatalf("%s: Append err = %v, want ErrIndexCorrupt", name, err)
		}
	}

	corrupt(idxOff, "magic")                        // index magic
	corrupt(idxOff+indexHeadLen+5, "entry")         // inside first entry
	corrupt(int64(len(file))-footerLen-1, "idxcrc") // index CRC field
	corrupt(int64(len(file))-footerLen, "idxlen")   // footer index length
	corrupt(int64(len(file))-1, "tailmagic")        // footer magic
}

func TestSnapshotAppendIsolation(t *testing.T) {
	rng := rand.New(rand.NewSource(99))
	gen1 := make([]byte, 5000)
	gen2 := make([]byte, 3000)
	rng.Read(gen1)
	rng.Read(gen2)
	path := filepath.Join(t.TempDir(), "a.blk")
	_, idxOffs := writeArchive(t, path, 1024, gen1, gen2)

	// Latest view sees both generations.
	r, err := Open(openFile(t, path))
	if err != nil {
		t.Fatal(err)
	}
	if r.Size() != int64(len(gen1)+len(gen2)) {
		t.Fatalf("size = %d", r.Size())
	}
	got, err := readRange(t, r, 0, r.Size())
	if err != nil || !bytes.Equal(got, append(gen1, gen2...)) {
		t.Fatalf("latest view: err=%v match=%v", err, bytes.Equal(got, append(gen1, gen2...)))
	}
	if err := r.Verify(); err != nil {
		t.Fatal(err)
	}

	// Snapshot of generation 1 is unpolluted by the append.
	s, err := OpenSnapshot(openFile(t, path), idxOffs[0])
	if err != nil {
		t.Fatal(err)
	}
	if s.Size() != int64(len(gen1)) {
		t.Fatalf("snapshot size = %d, want %d", s.Size(), len(gen1))
	}
	got, err = readRange(t, s, 0, s.Size())
	if err != nil || !bytes.Equal(got, gen1) {
		t.Fatalf("snapshot view: err=%v match=%v", err, bytes.Equal(got, gen1))
	}
	if _, err := s.ReadAt(make([]byte, 1), s.Size()); err != io.EOF {
		t.Fatalf("snapshot read past gen1: err = %v, want EOF", err)
	}
	if err := s.Verify(); err != nil {
		t.Fatal(err)
	}

	// A bogus snapshot offset is rejected.
	if _, err := OpenSnapshot(openFile(t, path), idxOffs[0]+3); !errors.Is(err, ErrIndexCorrupt) {
		t.Fatalf("misaligned snapshot: err = %v, want ErrIndexCorrupt", err)
	}
}

func TestTruncationByteByByte(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	gen1 := make([]byte, 200)
	gen2 := make([]byte, 150)
	rng.Read(gen1)
	rng.Read(gen2)
	all := append(append([]byte(nil), gen1...), gen2...)
	dir := t.TempDir()
	src := filepath.Join(dir, "src.blk")
	file, idxOffs := writeArchive(t, src, 32, gen1, gen2)
	gen1IdxEnd := int(idxOffs[0]) + int(binaryIndexLen(t, src, idxOffs[0]))
	gen1FooterEnd := gen1IdxEnd + footerLen

	for l := 0; l <= len(file); l++ {
		p := filepath.Join(dir, "trunc")
		if err := os.WriteFile(p, file[:l], 0o644); err != nil {
			t.Fatal(err)
		}
		// Latest view: a truncation may only open when it lands exactly on
		// a generation boundary (a valid shorter archive); then it must
		// serve exactly the corresponding plaintext prefix.
		if r, err := Open(openFile(t, p)); err == nil {
			got, err := readRange(t, r, 0, r.Size())
			if err != nil || !bytes.Equal(got, all[:r.Size()]) {
				t.Fatalf("len=%d: opened but latest view broken: err=%v", l, err)
			}
			if l != len(file) && l != gen1FooterEnd {
				t.Fatalf("len=%d: truncated file opened as latest", l)
			}
		}
		// Snapshot view: opens iff generation 1's index survives; then
		// generation 1 (which lies entirely before its index) must be
		// fully readable and correct.
		s, err := OpenSnapshot(openFile(t, p), idxOffs[0])
		if l >= gen1IdxEnd && err != nil {
			t.Fatalf("len=%d: snapshot should open: %v", l, err)
		}
		if err == nil {
			got, err := readRange(t, s, 0, s.Size())
			if err != nil || !bytes.Equal(got, gen1) {
				t.Fatalf("len=%d: snapshot read broken: err=%v", l, err)
			}
		}
	}
}

func binaryIndexLen(t *testing.T, path string, idxOff int64) uint64 {
	t.Helper()
	f := openFile(t, path)
	defer f.Close()
	head := make([]byte, indexHeadLen)
	if _, err := f.ReadAt(head, idxOff); err != nil {
		t.Fatal(err)
	}
	numBlocks := uint64(binary_LittleEndian_Uint32(head[12:16]))
	hashLen := uint64(binary_LittleEndian_Uint16(head[24:26]))
	return uint64(indexHeadLen) + hashLen + numBlocks*entryLen + indexCrcLen
}

func TestEmptyAndSmallArchives(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.blk")
	writeArchive(t, path, 64, nil)
	r, err := Open(openFile(t, path))
	if err != nil {
		t.Fatal(err)
	}
	if r.Size() != 0 || r.NumBlocks() != 0 {
		t.Fatalf("empty archive: size=%d blocks=%d", r.Size(), r.NumBlocks())
	}
	if _, err := r.ReadAt(make([]byte, 1), 0); err != io.EOF {
		t.Fatalf("empty read: err = %v, want EOF", err)
	}
	if err := r.Verify(); err != nil {
		t.Fatal(err)
	}

	// Single byte, and data exactly one block.
	for _, n := range []int{1, 64, 65} {
		data := bytes.Repeat([]byte{0xAB}, n)
		p := filepath.Join(t.TempDir(), "s.blk")
		writeArchive(t, p, 64, data)
		r, err := Open(openFile(t, p))
		if err != nil {
			t.Fatal(err)
		}
		got, err := readRange(t, r, 0, int64(n))
		if err != nil || !bytes.Equal(got, data) {
			t.Fatalf("n=%d: err=%v match=%v", n, err, bytes.Equal(got, data))
		}
	}
}
