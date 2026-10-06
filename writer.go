package blockstore

import (
	"bytes"
	"compress/flate"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"os"
)

// Writer appends compressed blocks to a file and finalizes it with an index.
type Writer struct {
	f         *os.File
	blockSize int
	entries   []blockEntry
	totalLen  uint64
	buf       []byte
	offset    uint64 // file offset where the next block record is written
	closed    bool
}

// Create starts a new file, truncating any existing one.
func Create(path string, blockSize int) (*Writer, error) {
	if blockSize <= 0 {
		return nil, fmt.Errorf("blockstore: invalid block size %d", blockSize)
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	hdr := make([]byte, headerSize)
	copy(hdr, headerMagic)
	binary.LittleEndian.PutUint32(hdr[8:12], version)
	binary.LittleEndian.PutUint32(hdr[12:16], uint32(blockSize))
	if _, err := f.WriteAt(hdr, 0); err != nil {
		f.Close()
		return nil, err
	}
	return &Writer{f: f, blockSize: blockSize, offset: headerSize}, nil
}

// OpenAppend reopens an existing finalized file for appending. The previous
// index is left untouched on disk, so readers holding an older index snapshot
// keep reading the old data consistently.
func OpenAppend(path string) (*Writer, error) {
	f, err := os.OpenFile(path, os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*Writer, error) {
		f.Close()
		return nil, err
	}
	hdr := make([]byte, headerSize)
	if _, err := f.ReadAt(hdr, 0); err != nil {
		return fail(ErrBadHeader)
	}
	if string(hdr[:8]) != headerMagic || binary.LittleEndian.Uint32(hdr[8:12]) != version {
		return fail(ErrBadHeader)
	}
	blockSize := int(binary.LittleEndian.Uint32(hdr[12:16]))
	entries, totalLen, _, err := readIndex(f)
	if err != nil {
		return fail(err)
	}
	st, err := f.Stat()
	if err != nil {
		return fail(err)
	}
	// Append after the old index; it stays readable for old snapshots.
	return &Writer{
		f:         f,
		blockSize: blockSize,
		entries:   entries,
		totalLen:  totalLen,
		offset:    uint64(st.Size()),
	}, nil
}

func (w *Writer) Write(p []byte) (int, error) {
	if w.closed {
		return 0, errors.New("blockstore: write on closed writer")
	}
	n := len(p)
	w.buf = append(w.buf, p...)
	for len(w.buf) >= w.blockSize {
		if err := w.flushBlock(w.buf[:w.blockSize]); err != nil {
			return 0, err
		}
		w.buf = w.buf[w.blockSize:]
	}
	return n, nil
}

func (w *Writer) flushBlock(raw []byte) error {
	var compressed bytes.Buffer
	zw, err := flate.NewWriter(&compressed, flate.DefaultCompression)
	if err != nil {
		return err
	}
	if _, err := zw.Write(raw); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	comp := compressed.Bytes()
	rec := make([]byte, blockRecHeader)
	binary.LittleEndian.PutUint32(rec[0:4], uint32(len(raw)))
	binary.LittleEndian.PutUint32(rec[4:8], uint32(len(comp)))
	binary.LittleEndian.PutUint32(rec[8:12], crc32.ChecksumIEEE(comp))
	if _, err := w.f.WriteAt(rec, int64(w.offset)); err != nil {
		return err
	}
	if _, err := w.f.WriteAt(comp, int64(w.offset)+blockRecHeader); err != nil {
		return err
	}
	w.entries = append(w.entries, blockEntry{
		offset:  w.offset,
		compLen: uint32(len(comp)),
		rawLen:  uint32(len(raw)),
		hash:    sha256.Sum256(raw),
	})
	w.offset += uint64(blockRecHeader + len(comp))
	w.totalLen += uint64(len(raw))
	return nil
}

// Close flushes the pending partial block, writes the index and trailer, and
// closes the file.
func (w *Writer) Close() error {
	if w.closed {
		return nil
	}
	w.closed = true
	if len(w.buf) > 0 {
		if err := w.flushBlock(w.buf); err != nil {
			w.f.Close()
			return err
		}
		w.buf = nil
	}
	index := encodeIndex(w.entries, w.totalLen)
	trailer := make([]byte, trailerSize)
	binary.LittleEndian.PutUint32(trailer[0:4], uint32(len(index)))
	copy(trailer[4:8], trailerMagic)
	if _, err := w.f.WriteAt(index, int64(w.offset)); err != nil {
		w.f.Close()
		return err
	}
	if _, err := w.f.WriteAt(trailer, int64(w.offset)+int64(len(index))); err != nil {
		w.f.Close()
		return err
	}
	if err := w.f.Sync(); err != nil {
		w.f.Close()
		return err
	}
	return w.f.Close()
}
