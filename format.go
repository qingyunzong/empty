package blockstore

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
)

// On-disk layout:
//
//	[header]            magic(8) version(4) blockSize(4)
//	[block record]*     rawLen(4) compLen(4) crc32(4) compressedData(compLen)
//	[index]             magic(8) numBlocks(4) totalLen(8) entries... rootHash(32) crc32(4)
//	[trailer]           indexLen(4) magic(4)
//
// Each index entry: offset(8) compLen(4) rawLen(4) sha256OfRawBlock(32).
// The root hash is sha256 over the concatenated per-block hashes, which lets
// appends extend the file without re-hashing old data.
const (
	headerMagic  = "BLKSTR01"
	indexMagic   = "BIDX0001"
	trailerMagic = "BST1"

	version        = 1
	headerSize     = 16
	trailerSize    = 8
	blockRecHeader = 12
	indexFixedSize = 8 + 4 + 8 + 32 + 4 // magic + numBlocks + totalLen + root + crc
	indexEntrySize = 8 + 4 + 4 + 32     // offset + compLen + rawLen + hash
)

var (
	// ErrIndexCorrupt is returned when the index/trailer is missing or fails
	// validation. Any query against such a file is rejected.
	ErrIndexCorrupt = errors.New("blockstore: index corrupt or missing")
	// ErrBadHeader is returned when the file header is not recognized.
	ErrBadHeader = errors.New("blockstore: bad file header")
	// ErrOutOfRange is returned for reads outside [0, Len).
	ErrOutOfRange = errors.New("blockstore: read out of range")
)

// BlockCorruptError reports that a single data block failed integrity checks.
// Only queries intersecting that block observe this error.
type BlockCorruptError struct {
	Block int
	Err   error
}

func (e *BlockCorruptError) Error() string {
	return fmt.Sprintf("blockstore: block %d corrupt: %v", e.Block, e.Err)
}

func (e *BlockCorruptError) Unwrap() error { return e.Err }

type blockEntry struct {
	offset  uint64 // file offset of the block record
	compLen uint32
	rawLen  uint32
	hash    [32]byte // sha256 of the uncompressed block data
}

func rootHash(entries []blockEntry) [32]byte {
	h := sha256.New()
	for _, e := range entries {
		h.Write(e.hash[:])
	}
	var root [32]byte
	copy(root[:], h.Sum(nil))
	return root
}

func encodeIndex(entries []blockEntry, totalLen uint64) []byte {
	buf := make([]byte, 0, indexFixedSize+len(entries)*indexEntrySize)
	buf = append(buf, indexMagic...)
	buf = binary.LittleEndian.AppendUint32(buf, uint32(len(entries)))
	buf = binary.LittleEndian.AppendUint64(buf, totalLen)
	for _, e := range entries {
		buf = binary.LittleEndian.AppendUint64(buf, e.offset)
		buf = binary.LittleEndian.AppendUint32(buf, e.compLen)
		buf = binary.LittleEndian.AppendUint32(buf, e.rawLen)
		buf = append(buf, e.hash[:]...)
	}
	root := rootHash(entries)
	buf = append(buf, root[:]...)
	crc := crc32.ChecksumIEEE(buf)
	buf = binary.LittleEndian.AppendUint32(buf, crc)
	return buf
}

func decodeIndex(buf []byte) (entries []blockEntry, totalLen uint64, root [32]byte, err error) {
	fail := func() ([]blockEntry, uint64, [32]byte, error) {
		return nil, 0, [32]byte{}, ErrIndexCorrupt
	}
	if len(buf) < indexFixedSize {
		return fail()
	}
	if crc32.ChecksumIEEE(buf[:len(buf)-4]) != binary.LittleEndian.Uint32(buf[len(buf)-4:]) {
		return fail()
	}
	if string(buf[:8]) != indexMagic {
		return fail()
	}
	numBlocks := binary.LittleEndian.Uint32(buf[8:12])
	totalLen = binary.LittleEndian.Uint64(buf[12:20])
	if len(buf) != indexFixedSize+int(numBlocks)*indexEntrySize {
		return fail()
	}
	entries = make([]blockEntry, 0, numBlocks)
	pos := 20
	for i := uint32(0); i < numBlocks; i++ {
		var e blockEntry
		e.offset = binary.LittleEndian.Uint64(buf[pos : pos+8])
		e.compLen = binary.LittleEndian.Uint32(buf[pos+8 : pos+12])
		e.rawLen = binary.LittleEndian.Uint32(buf[pos+12 : pos+16])
		copy(e.hash[:], buf[pos+16:pos+48])
		entries = append(entries, e)
		pos += indexEntrySize
	}
	copy(root[:], buf[pos:pos+32])
	if root != rootHash(entries) {
		return fail()
	}
	return entries, totalLen, root, nil
}
