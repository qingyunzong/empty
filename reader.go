package blockstore

import (
	"bytes"
	"compress/flate"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"sort"
)

// Reader performs random-range reads over a finalized file. The index is
// loaded once at Open, so the reader is a stable snapshot: later appends to
// the same path do not affect it.
type Reader struct {
	f       *os.File
	entries []blockEntry
	prefix  []int64 // prefix[i] = uncompressed offset where block i starts
	total   int64
	root    [32]byte
}

// Open loads the index snapshot. A missing or corrupt index fails here, so
// every query against a corrupt-index file is rejected.
func Open(path string) (*Reader, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	hdr := make([]byte, headerSize)
	if _, err := f.ReadAt(hdr, 0); err != nil || string(hdr[:8]) != headerMagic ||
		binary.LittleEndian.Uint32(hdr[8:12]) != version {
		f.Close()
		return nil, ErrBadHeader
	}
	entries, totalLen, root, err := readIndex(f)
	if err != nil {
		f.Close()
		return nil, err
	}
	prefix := make([]int64, len(entries)+1)
	for i, e := range entries {
		prefix[i+1] = prefix[i] + int64(e.rawLen)
	}
	if prefix[len(entries)] != int64(totalLen) {
		f.Close()
		return nil, ErrIndexCorrupt
	}
	return &Reader{f: f, entries: entries, prefix: prefix, total: int64(totalLen), root: root}, nil
}

func readIndex(f *os.File) ([]blockEntry, uint64, [32]byte, error) {
	st, err := f.Stat()
	if err != nil {
		return nil, 0, [32]byte{}, err
	}
	size := st.Size()
	if size < headerSize+trailerSize {
		return nil, 0, [32]byte{}, ErrIndexCorrupt
	}
	trailer := make([]byte, trailerSize)
	if _, err := f.ReadAt(trailer, size-trailerSize); err != nil {
		return nil, 0, [32]byte{}, ErrIndexCorrupt
	}
	if string(trailer[4:8]) != trailerMagic {
		return nil, 0, [32]byte{}, ErrIndexCorrupt
	}
	indexLen := int64(binary.LittleEndian.Uint32(trailer[0:4]))
	indexOff := size - trailerSize - indexLen
	if indexLen < indexFixedSize || indexOff < headerSize {
		return nil, 0, [32]byte{}, ErrIndexCorrupt
	}
	buf := make([]byte, indexLen)
	if _, err := f.ReadAt(buf, indexOff); err != nil {
		return nil, 0, [32]byte{}, ErrIndexCorrupt
	}
	return decodeIndex(buf)
}

// Len returns the total uncompressed length visible to this snapshot.
func (r *Reader) Len() int64 { return r.total }

// Close releases the underlying file.
func (r *Reader) Close() error { return r.f.Close() }

func (r *Reader) findBlock(off int64) int {
	return sort.Search(len(r.entries), func(i int) bool {
		return r.prefix[i+1] > off
	})
}

func (r *Reader) readBlock(i int) ([]byte, error) {
	e := r.entries[i]
	wrap := func(err error) error { return &BlockCorruptError{Block: i, Err: err} }
	buf := make([]byte, blockRecHeader+int64(e.compLen))
	if _, err := r.f.ReadAt(buf, int64(e.offset)); err != nil {
		return nil, wrap(err)
	}
	if binary.LittleEndian.Uint32(buf[0:4]) != e.rawLen ||
		binary.LittleEndian.Uint32(buf[4:8]) != e.compLen {
		return nil, wrap(fmt.Errorf("record header mismatch"))
	}
	comp := buf[blockRecHeader:]
	if crc32.ChecksumIEEE(comp) != binary.LittleEndian.Uint32(buf[8:12]) {
		return nil, wrap(fmt.Errorf("crc mismatch"))
	}
	zr := flate.NewReader(bytes.NewReader(comp))
	raw, err := io.ReadAll(zr)
	zr.Close()
	if err != nil {
		return nil, wrap(err)
	}
	if len(raw) != int(e.rawLen) {
		return nil, wrap(fmt.Errorf("decompressed length mismatch"))
	}
	return raw, nil
}

// ReadRange returns the uncompressed bytes in [off, off+n).
func (r *Reader) ReadRange(off, n int64) ([]byte, error) {
	if off < 0 || n < 0 || off+n > r.total {
		return nil, ErrOutOfRange
	}
	out := make([]byte, 0, n)
	for n > 0 {
		bi := r.findBlock(off)
		raw, err := r.readBlock(bi)
		if err != nil {
			return nil, err
		}
		start := off - r.prefix[bi]
		take := int64(len(raw)) - start
		if take > n {
			take = n
		}
		out = append(out, raw[start:start+take]...)
		off += take
		n -= take
	}
	return out, nil
}

// ReadAt implements io.ReaderAt over the uncompressed view.
func (r *Reader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, ErrOutOfRange
	}
	if off >= r.total {
		return 0, io.EOF
	}
	n := int64(len(p))
	if off+n > r.total {
		n = r.total - off
	}
	got, err := r.ReadRange(off, n)
	if err != nil {
		return 0, err
	}
	copy(p, got)
	if int(n) < len(p) {
		return int(n), io.EOF
	}
	return int(n), nil
}

// Verify re-reads every block, checking each block's CRC and SHA-256 plus the
// whole-file root hash.
func (r *Reader) Verify() error {
	for i, e := range r.entries {
		raw, err := r.readBlock(i)
		if err != nil {
			return err
		}
		if sha256.Sum256(raw) != e.hash {
			return &BlockCorruptError{Block: i, Err: fmt.Errorf("hash mismatch")}
		}
	}
	if rootHash(r.entries) != r.root {
		return fmt.Errorf("blockstore: root hash mismatch")
	}
	return nil
}
