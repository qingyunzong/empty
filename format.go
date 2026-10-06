// Package blkarc implements an append-only archive format built from
// independently compressed blocks plus a checksummed index (offset table).
//
// Layout:
//
//	[block 0][block 1]...[block N][index][footer]            <- generation 1
//	[block N+1]...[block M][index][footer]                    <- generation 2 (append)
//
// Each block is flate-compressed and carries a CRC32 in the index, so a
// damaged block only fails reads that intersect it. The index records every
// block's offset/length/CRC plus the running SHA-256 state of all plaintext,
// and is itself CRC32-protected: a damaged index fails to load, rejecting
// every query. The footer is a fixed 16-byte trailer
// [indexLen uint64 LE]["GBLKEND1"] pointing back at the last index, so old
// index snapshots remain readable after appends.
package blkarc

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
)

const (
	indexMagic   = "GBLKIDX1"
	tailMagic    = "GBLKEND1"
	magicLen     = 8
	footerLen    = 8 + magicLen             // indexLen uint64 + tail magic
	entryLen     = 8 + 4 + 4 + 4            // offset u64, compLen u32, rawLen u32, crc u32
	indexHeadLen = magicLen + 4 + 4 + 8 + 2 // magic, blockSize, numBlocks, dataSize, hashStateLen
	indexCrcLen  = 4

	// DefaultBlockSize is the plaintext block size used by Create when the
	// caller passes 0.
	DefaultBlockSize = 64 * 1024
)

// ErrIndexCorrupt is returned when the index or footer fails validation.
// Every query is rejected because no trustworthy offset table exists.
var ErrIndexCorrupt = errors.New("blkarc: index corrupt or missing")

// BlockError reports an integrity failure isolated to a single block.
type BlockError struct {
	Index int
	Err   error
}

func (e *BlockError) Error() string {
	return fmt.Sprintf("blkarc: block %d: %v", e.Index, e.Err)
}

func (e *BlockError) Unwrap() error { return e.Err }

type entry struct {
	offset  uint64
	compLen uint32
	rawLen  uint32
	crc     uint32
}

type index struct {
	blockSize uint32
	dataSize  uint64
	hashState []byte // marshaled crypto/sha256 state over all plaintext
	entries   []entry
}

func encodeIndex(idx *index) []byte {
	buf := make([]byte, 0, indexHeadLen+len(idx.hashState)+len(idx.entries)*entryLen+indexCrcLen)
	buf = append(buf, indexMagic...)
	buf = binary.LittleEndian.AppendUint32(buf, idx.blockSize)
	buf = binary.LittleEndian.AppendUint32(buf, uint32(len(idx.entries)))
	buf = binary.LittleEndian.AppendUint64(buf, idx.dataSize)
	buf = binary.LittleEndian.AppendUint16(buf, uint16(len(idx.hashState)))
	buf = append(buf, idx.hashState...)
	for _, e := range idx.entries {
		buf = binary.LittleEndian.AppendUint64(buf, e.offset)
		buf = binary.LittleEndian.AppendUint32(buf, e.compLen)
		buf = binary.LittleEndian.AppendUint32(buf, e.rawLen)
		buf = binary.LittleEndian.AppendUint32(buf, e.crc)
	}
	return binary.LittleEndian.AppendUint32(buf, crc32.ChecksumIEEE(buf))
}

// decodeIndex parses and validates an index record. dataLimit is the file
// offset of the index itself; every referenced block must lie before it.
func decodeIndex(buf []byte, dataLimit uint64) (*index, error) {
	if len(buf) < indexHeadLen+indexCrcLen {
		return nil, ErrIndexCorrupt
	}
	if crc32.ChecksumIEEE(buf[:len(buf)-indexCrcLen]) != binary.LittleEndian.Uint32(buf[len(buf)-indexCrcLen:]) {
		return nil, ErrIndexCorrupt
	}
	if string(buf[:magicLen]) != indexMagic {
		return nil, ErrIndexCorrupt
	}
	blockSize := binary.LittleEndian.Uint32(buf[8:12])
	numBlocks := binary.LittleEndian.Uint32(buf[12:16])
	dataSize := binary.LittleEndian.Uint64(buf[16:24])
	hashLen := int(binary.LittleEndian.Uint16(buf[24:26]))
	if blockSize == 0 {
		return nil, ErrIndexCorrupt
	}
	need := indexHeadLen + hashLen + int(numBlocks)*entryLen + indexCrcLen
	if numBlocks > (1<<31)/entryLen || need != len(buf) {
		return nil, ErrIndexCorrupt
	}
	idx := &index{
		blockSize: blockSize,
		dataSize:  dataSize,
		hashState: append([]byte(nil), buf[indexHeadLen:indexHeadLen+hashLen]...),
	}
	pos := indexHeadLen + hashLen
	var prevEnd uint64
	var rawTotal uint64
	for i := 0; i < int(numBlocks); i++ {
		e := entry{
			offset:  binary.LittleEndian.Uint64(buf[pos:]),
			compLen: binary.LittleEndian.Uint32(buf[pos+8:]),
			rawLen:  binary.LittleEndian.Uint32(buf[pos+12:]),
			crc:     binary.LittleEndian.Uint32(buf[pos+16:]),
		}
		pos += entryLen
		if e.rawLen == 0 || e.rawLen > blockSize || e.compLen == 0 {
			return nil, ErrIndexCorrupt
		}
		end := e.offset + uint64(e.compLen)
		if end > dataLimit || e.offset < prevEnd {
			return nil, ErrIndexCorrupt
		}
		prevEnd = end
		rawTotal += uint64(e.rawLen)
		idx.entries = append(idx.entries, e)
	}
	if rawTotal != dataSize {
		return nil, ErrIndexCorrupt
	}
	return idx, nil
}
