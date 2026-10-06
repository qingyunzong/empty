package blockstore

import (
	"bytes"
	"errors"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"testing"
)

func writeFile(t *testing.T, path string, data []byte, blockSize int) {
	t.Helper()
	w, err := Create(path, blockSize)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if _, err := w.Write(data); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func randomData(rng *rand.Rand, n int) []byte {
	b := make([]byte, n)
	rng.Read(b)
	return b
}

func readFileBytes(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	return b
}

// writeBytesTo makes a mutated copy of src at a fresh temp path and returns it.
func mutatedCopy(t *testing.T, src string, mutate func([]byte)) string {
	t.Helper()
	b := readFileBytes(t, src)
	mutate(b)
	dst := filepath.Join(t.TempDir(), "mutated.blk")
	if err := os.WriteFile(dst, b, 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	return dst
}

func TestRandomSlices(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	data := randomData(rng, 200_000)
	path := filepath.Join(t.TempDir(), "f.blk")
	writeFile(t, path, data, 4096)

	r, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer r.Close()
	if r.Len() != int64(len(data)) {
		t.Fatalf("Len = %d, want %d", r.Len(), len(data))
	}
	if err := r.Verify(); err != nil {
		t.Fatalf("Verify: %v", err)
	}
	for i := 0; i < 1000; i++ {
		off := rng.Int63n(int64(len(data)) + 1)
		maxN := int64(len(data)) - off
		n := rng.Int63n(maxN + 1)
		if n > 20_000 {
			n = 20_000
		}
		got, err := r.ReadRange(off, n)
		if err != nil {
			t.Fatalf("ReadRange(%d, %d): %v", off, n, err)
		}
		if !bytes.Equal(got, data[off:off+n]) {
			t.Fatalf("ReadRange(%d, %d) mismatch", off, n)
		}
	}
	// Full read via ReadAt.
	full, err := r.ReadRange(0, r.Len())
	if err != nil {
		t.Fatalf("ReadRange full: %v", err)
	}
	if !bytes.Equal(full, data) {
		t.Fatal("full read mismatch")
	}
}

func TestBlockCorruptionIsolation(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	const blockSize = 1024
	const numBlocks = 10
	data := randomData(rng, blockSize*numBlocks)
	path := filepath.Join(t.TempDir(), "f.blk")
	writeFile(t, path, data, blockSize)

	// Learn block offsets from a clean open.
	r, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	offsets := make([]uint64, numBlocks)
	for i := range offsets {
		offsets[i] = r.entries[i].offset
	}
	r.Close()

	for i := 0; i < numBlocks; i++ {
		bad := mutatedCopy(t, path, func(b []byte) {
			b[offsets[i]+blockRecHeader] ^= 0xFF // flip inside compressed payload
		})
		br, err := Open(bad)
		if err != nil {
			t.Fatalf("block %d: Open should succeed with intact index: %v", i, err)
		}
		// Query intersecting the corrupt block must fail.
		off := int64(i * blockSize)
		if _, err := br.ReadRange(off, blockSize); err == nil {
			t.Fatalf("block %d: intersecting read should fail", i)
		} else {
			var bce *BlockCorruptError
			if !errors.As(err, &bce) || bce.Block != i {
				t.Fatalf("block %d: want BlockCorruptError{%d}, got %v", i, i, err)
			}
		}
		// Whole-file read and Verify must fail too.
		if _, err := br.ReadRange(0, br.Len()); err == nil {
			t.Fatalf("block %d: full read should fail", i)
		}
		if err := br.Verify(); err == nil {
			t.Fatalf("block %d: Verify should fail", i)
		}
		// Queries not touching block i must succeed.
		j := (i + 1) % numBlocks
		got, err := br.ReadRange(int64(j*blockSize), blockSize)
		if err != nil {
			t.Fatalf("block %d: clean block %d read failed: %v", i, j, err)
		}
		if !bytes.Equal(got, data[j*blockSize:(j+1)*blockSize]) {
			t.Fatalf("block %d: clean block %d data mismatch", i, j)
		}
		br.Close()
	}
}

func TestIndexCorruptionRejectsAll(t *testing.T) {
	rng := rand.New(rand.NewSource(9))
	data := randomData(rng, 5000)
	path := filepath.Join(t.TempDir(), "f.blk")
	writeFile(t, path, data, 512)
	size := int64(len(readFileBytes(t, path)))

	cases := map[string]func(b []byte){
		"trailer magic": func(b []byte) { b[size-1] ^= 0xFF },
		"index length":  func(b []byte) { b[size-8] ^= 0xFF },
		"index crc":     func(b []byte) { b[size-9] ^= 0xFF },
		"index root":    func(b []byte) { b[size-13] ^= 0xFF },
		"index entry":   func(b []byte) { b[size-100] ^= 0xFF },
		"index magic": func(b []byte) {
			i := bytes.Index(b, []byte(indexMagic))
			if i < 0 {
				panic("index magic not found")
			}
			b[i] ^= 0xFF
		},
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			bad := mutatedCopy(t, path, mutate)
			if _, err := Open(bad); !errors.Is(err, ErrIndexCorrupt) {
				t.Fatalf("Open: want ErrIndexCorrupt, got %v", err)
			}
		})
	}
}

func TestAppendSnapshotIsolation(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	a := randomData(rng, 5000)
	b := randomData(rng, 7000)
	path := filepath.Join(t.TempDir(), "f.blk")
	writeFile(t, path, a, 1024)

	// Snapshot reader before the append.
	r1, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer r1.Close()

	w, err := OpenAppend(path)
	if err != nil {
		t.Fatalf("OpenAppend: %v", err)
	}
	if _, err := w.Write(b); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// Old snapshot: unchanged length and data, still verifies.
	if r1.Len() != int64(len(a)) {
		t.Fatalf("snapshot Len = %d, want %d", r1.Len(), len(a))
	}
	got, err := r1.ReadRange(0, r1.Len())
	if err != nil {
		t.Fatalf("snapshot ReadRange: %v", err)
	}
	if !bytes.Equal(got, a) {
		t.Fatal("snapshot data changed after append")
	}
	if err := r1.Verify(); err != nil {
		t.Fatalf("snapshot Verify: %v", err)
	}

	// New reader sees the concatenation.
	r2, err := Open(path)
	if err != nil {
		t.Fatalf("Open after append: %v", err)
	}
	defer r2.Close()
	want := append(append([]byte{}, a...), b...)
	if r2.Len() != int64(len(want)) {
		t.Fatalf("Len after append = %d, want %d", r2.Len(), len(want))
	}
	for i := 0; i < 300; i++ {
		off := rng.Int63n(int64(len(want)) + 1)
		n := rng.Int63n(int64(len(want)) - off + 1)
		got, err := r2.ReadRange(off, n)
		if err != nil {
			t.Fatalf("ReadRange(%d, %d): %v", off, n, err)
		}
		if !bytes.Equal(got, want[off:off+n]) {
			t.Fatalf("ReadRange(%d, %d) mismatch", off, n)
		}
	}
	if err := r2.Verify(); err != nil {
		t.Fatalf("Verify after append: %v", err)
	}
}

func TestTruncationByteByByte(t *testing.T) {
	rng := rand.New(rand.NewSource(13))
	data := randomData(rng, 2500)
	path := filepath.Join(t.TempDir(), "f.blk")
	writeFile(t, path, data, 512)
	orig := readFileBytes(t, path)

	for l := 0; l <= len(orig); l++ {
		dst := filepath.Join(t.TempDir(), "trunc.blk")
		if err := os.WriteFile(dst, orig[:l], 0o644); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
		r, err := Open(dst)
		if l == len(orig) {
			if err != nil {
				t.Fatalf("len %d: Open failed on intact file: %v", l, err)
			}
			got, err := r.ReadRange(0, r.Len())
			if err != nil || !bytes.Equal(got, data) {
				t.Fatalf("len %d: intact read failed: %v", l, err)
			}
			r.Close()
			continue
		}
		// Any truncation removes index/trailer bytes: open must fail cleanly.
		if !errors.Is(err, ErrIndexCorrupt) && !errors.Is(err, ErrBadHeader) {
			t.Fatalf("len %d: want ErrIndexCorrupt, got %v", l, err)
		}
	}
}

func TestSnapshotSurvivesTruncation(t *testing.T) {
	rng := rand.New(rand.NewSource(17))
	const blockSize = 512
	data := randomData(rng, blockSize*5)
	path := filepath.Join(t.TempDir(), "f.blk")
	writeFile(t, path, data, blockSize)

	r, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer r.Close()
	// Truncate away the tail, cutting into block 3's payload.
	cut := int64(r.entries[3].offset) + blockRecHeader + 10
	if err := os.Truncate(path, cut); err != nil {
		t.Fatalf("Truncate: %v", err)
	}
	// Blocks fully before the cut still read fine.
	got, err := r.ReadRange(0, blockSize*3)
	if err != nil {
		t.Fatalf("read of intact prefix: %v", err)
	}
	if !bytes.Equal(got, data[:blockSize*3]) {
		t.Fatal("intact prefix mismatch after truncation")
	}
	// Reads touching truncated blocks fail, without panic.
	if _, err := r.ReadRange(blockSize*3, blockSize); err == nil {
		t.Fatal("read of truncated block should fail")
	}
	if _, err := r.ReadRange(0, r.Len()); err == nil {
		t.Fatal("full read should fail after truncation")
	}
}

func TestSmallSizes(t *testing.T) {
	for _, n := range []int{0, 1, 100, 4095, 4096, 4097, 8192} {
		rng := rand.New(rand.NewSource(int64(n) + 1))
		data := randomData(rng, n)
		path := filepath.Join(t.TempDir(), "f.blk")
		writeFile(t, path, data, 4096)
		r, err := Open(path)
		if err != nil {
			t.Fatalf("n=%d: Open: %v", n, err)
		}
		if r.Len() != int64(n) {
			t.Fatalf("n=%d: Len = %d", n, r.Len())
		}
		got, err := r.ReadRange(0, r.Len())
		if err != nil {
			t.Fatalf("n=%d: ReadRange: %v", n, err)
		}
		if !bytes.Equal(got, data) {
			t.Fatalf("n=%d: data mismatch", n)
		}
		if err := r.Verify(); err != nil {
			t.Fatalf("n=%d: Verify: %v", n, err)
		}
		r.Close()
	}
}

func TestReadAtSemantics(t *testing.T) {
	rng := rand.New(rand.NewSource(23))
	data := randomData(rng, 3000)
	path := filepath.Join(t.TempDir(), "f.blk")
	writeFile(t, path, data, 512)

	r, err := Open(path)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer r.Close()

	buf := make([]byte, 100)
	if n, err := r.ReadAt(buf, 0); n != 100 || err != nil {
		t.Fatalf("ReadAt: n=%d err=%v", n, err)
	}
	if !bytes.Equal(buf, data[:100]) {
		t.Fatal("ReadAt data mismatch")
	}
	// Partial read at the tail returns io.EOF.
	if n, err := r.ReadAt(buf, 2950); n != 50 || err != io.EOF {
		t.Fatalf("tail ReadAt: n=%d err=%v", n, err)
	}
	// Fully past the end.
	if n, err := r.ReadAt(buf, 3000); n != 0 || err != io.EOF {
		t.Fatalf("EOF ReadAt: n=%d err=%v", n, err)
	}
	// Out of range.
	if _, err := r.ReadRange(0, 3001); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("ReadRange overflow: %v", err)
	}
	if _, err := r.ReadRange(-1, 5); !errors.Is(err, ErrOutOfRange) {
		t.Fatalf("ReadRange negative: %v", err)
	}
}
