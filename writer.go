package blkarc

import (
	"bytes"
	"compress/flate"
	"crypto/sha256"
	"encoding/binary"
	"hash"
	"hash/crc32"
	"io"
	"os"
)

// Writer appends plaintext to an archive, flushing independently compressed
// blocks and, on Close, a CRC-protected index plus footer.
type Writer struct {
	f         *os.File
	blockSize int
	idx       index
	hasher    hash.Hash
	buf       []byte // pending plaintext, len < blockSize
	offset    int64  // next write position
	closed    bool
}

// Create starts a new empty archive in f, truncating it first.
func Create(f *os.File, blockSize int) (*Writer, error) {
	if blockSize <= 0 {
		blockSize = DefaultBlockSize
	}
	if err := f.Truncate(0); err != nil {
		return nil, err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return &Writer{
		f:         f,
		blockSize: blockSize,
		hasher:    sha256.New(),
		idx:       index{blockSize: uint32(blockSize)},
	}, nil
}

// Append reopens an existing archive for a new generation. The last index is
// loaded and validated; if it is corrupt, Append fails and nothing is
// touched. Previously committed generations stay byte-for-byte intact.
func Append(f *os.File) (*Writer, error) {
	r, err := Open(f)
	if err != nil {
		return nil, err
	}
	end, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return nil, err
	}
	h := sha256.New()
	if err := h.(interface{ UnmarshalBinary([]byte) error }).UnmarshalBinary(r.idx.hashState); err != nil {
		return nil, err
	}
	return &Writer{
		f:         f,
		blockSize: int(r.idx.blockSize),
		idx:       *r.idx,
		hasher:    h,
		offset:    end,
	}, nil
}

func (w *Writer) Write(p []byte) (int, error) {
	if w.closed {
		return 0, os.ErrClosed
	}
	w.hasher.Write(p)
	w.idx.dataSize += uint64(len(p))
	w.buf = append(w.buf, p...)
	for len(w.buf) >= w.blockSize {
		if err := w.flushBlock(w.buf[:w.blockSize]); err != nil {
			return 0, err
		}
		w.buf = w.buf[w.blockSize:]
	}
	return len(p), nil
}

func (w *Writer) flushBlock(raw []byte) error {
	var comp bytes.Buffer
	zw, err := flate.NewWriter(&comp, flate.DefaultCompression)
	if err != nil {
		return err
	}
	if _, err := zw.Write(raw); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if _, err := w.f.WriteAt(comp.Bytes(), w.offset); err != nil {
		return err
	}
	w.idx.entries = append(w.idx.entries, entry{
		offset:  uint64(w.offset),
		compLen: uint32(comp.Len()),
		rawLen:  uint32(len(raw)),
		crc:     crc32.ChecksumIEEE(comp.Bytes()),
	})
	w.offset += int64(comp.Len())
	return nil
}

// Close flushes the final partial block and commits the index and footer.
// It returns the offset of the committed index, which can later be passed to
// OpenSnapshot to read exactly this generation even after further appends.
func (w *Writer) Close() (indexOffset int64, err error) {
	if w.closed {
		return 0, os.ErrClosed
	}
	w.closed = true
	if len(w.buf) > 0 {
		if err := w.flushBlock(w.buf); err != nil {
			return 0, err
		}
		w.buf = nil
	}
	state, err := w.hasher.(interface{ MarshalBinary() ([]byte, error) }).MarshalBinary()
	if err != nil {
		return 0, err
	}
	w.idx.hashState = state
	rec := encodeIndex(&w.idx)
	if _, err := w.f.WriteAt(rec, w.offset); err != nil {
		return 0, err
	}
	footer := binary.LittleEndian.AppendUint64(nil, uint64(len(rec)))
	footer = append(footer, tailMagic...)
	if _, err := w.f.WriteAt(footer, w.offset+int64(len(rec))); err != nil {
		return 0, err
	}
	return w.offset, w.f.Sync()
}
