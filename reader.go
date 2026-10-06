package blkarc

import (
	"bytes"
	"compress/flate"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
	"os"
)

// Reader performs random-access range reads over one committed generation of
// an archive. It is safe for concurrent use.
type Reader struct {
	f   *os.File
	idx *index
}

// Open loads the most recent generation by reading the footer at the end of
// the file. A missing or corrupt footer/index yields ErrIndexCorrupt and no
// query is possible.
func Open(f *os.File) (*Reader, error) {
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := st.Size()
	if size < footerLen {
		return nil, ErrIndexCorrupt
	}
	tail := make([]byte, footerLen)
	if _, err := f.ReadAt(tail, size-footerLen); err != nil {
		return nil, ErrIndexCorrupt
	}
	if string(tail[8:]) != tailMagic {
		return nil, ErrIndexCorrupt
	}
	indexLen := binary.LittleEndian.Uint64(tail[:8])
	if indexLen == 0 || indexLen > uint64(size-footerLen) {
		return nil, ErrIndexCorrupt
	}
	return openAt(f, int64(uint64(size-footerLen)-indexLen))
}

// OpenSnapshot loads the generation whose index starts at indexOffset (as
// returned by Writer.Close). Appends after that point are invisible to the
// snapshot, and the snapshot's bytes are never modified by appends.
func OpenSnapshot(f *os.File, indexOffset int64) (*Reader, error) {
	if indexOffset < 0 {
		return nil, ErrIndexCorrupt
	}
	return openAt(f, indexOffset)
}

func openAt(f *os.File, indexOffset int64) (*Reader, error) {
	head := make([]byte, indexHeadLen)
	if _, err := f.ReadAt(head, indexOffset); err != nil {
		return nil, ErrIndexCorrupt
	}
	if string(head[:magicLen]) != indexMagic {
		return nil, ErrIndexCorrupt
	}
	numBlocks := binary.LittleEndian.Uint32(head[12:16])
	hashLen := uint64(binary.LittleEndian.Uint16(head[24:26]))
	if numBlocks > (1<<31)/entryLen {
		return nil, ErrIndexCorrupt
	}
	total := int64(indexHeadLen) + int64(hashLen) + int64(numBlocks)*entryLen + indexCrcLen
	buf := make([]byte, total)
	if _, err := f.ReadAt(buf, indexOffset); err != nil {
		return nil, ErrIndexCorrupt
	}
	idx, err := decodeIndex(buf, uint64(indexOffset))
	if err != nil {
		return nil, err
	}
	return &Reader{f: f, idx: idx}, nil
}

// Size returns the total plaintext size of this generation.
func (r *Reader) Size() int64 { return int64(r.idx.dataSize) }

// NumBlocks returns the number of compressed blocks in this generation.
func (r *Reader) NumBlocks() int { return len(r.idx.entries) }

// BlockSpan returns the file offset, compressed length, and raw length of
// block i. It is intended for diagnostics and tests.
func (r *Reader) BlockSpan(i int) (offset int64, compLen, rawLen int) {
	e := r.idx.entries[i]
	return int64(e.offset), int(e.compLen), int(e.rawLen)
}

// ReadAt reads len(p) plaintext bytes starting at off. Only blocks
// intersecting the requested range are fetched and verified; a corrupt block
// fails the read with *BlockError without affecting disjoint ranges.
func (r *Reader) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, errors.New("blkarc: negative offset")
	}
	size := int64(r.idx.dataSize)
	if off >= size {
		if len(p) == 0 {
			return 0, nil
		}
		return 0, io.EOF
	}
	end := off + int64(len(p))
	truncated := false
	if end > size {
		end = size
		truncated = true
	}
	n := 0
	var bStart int64 // plaintext offset of block i; partial blocks (from
	// earlier generations) make this differ from i*blockSize
	for i := range r.idx.entries {
		e := &r.idx.entries[i]
		bEnd := bStart + int64(e.rawLen)
		if bEnd > off && bStart < end {
			raw, err := r.readBlock(i)
			if err != nil {
				return n, err
			}
			lo := max(off-bStart, 0)
			hi := min(end-bStart, int64(e.rawLen))
			n += copy(p[n:], raw[lo:hi])
		}
		bStart = bEnd
		if bStart >= end {
			break
		}
	}
	if truncated {
		return n, io.EOF
	}
	return n, nil
}

func (r *Reader) readBlock(i int) ([]byte, error) {
	e := &r.idx.entries[i]
	comp := make([]byte, e.compLen)
	if _, err := r.f.ReadAt(comp, int64(e.offset)); err != nil {
		return nil, &BlockError{Index: i, Err: err}
	}
	if crc32.ChecksumIEEE(comp) != e.crc {
		return nil, &BlockError{Index: i, Err: errors.New("crc mismatch")}
	}
	zr := flate.NewReader(bytes.NewReader(comp))
	raw, err := io.ReadAll(zr)
	if cerr := zr.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, &BlockError{Index: i, Err: fmt.Errorf("decompress: %w", err)}
	}
	if len(raw) != int(e.rawLen) {
		return nil, &BlockError{Index: i, Err: errors.New("decompressed length mismatch")}
	}
	return raw, nil
}

// Verify reads the entire generation and checks it against the whole-file
// SHA-256 recorded in the index.
func (r *Reader) Verify() error {
	h := sha256.New()
	buf := make([]byte, 64*1024)
	var off int64
	for off < r.Size() {
		n := int64(len(buf))
		if rem := r.Size() - off; rem < n {
			n = rem
		}
		if _, err := r.ReadAt(buf[:n], off); err != nil {
			return err
		}
		h.Write(buf[:n])
		off += n
	}
	state, err := h.(interface{ MarshalBinary() ([]byte, error) }).MarshalBinary()
	if err != nil {
		return err
	}
	if !bytes.Equal(state, r.idx.hashState) {
		return errors.New("blkarc: whole-file hash mismatch")
	}
	return nil
}
