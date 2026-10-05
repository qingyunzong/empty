package store

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"sort"
)

// Index file layout (all little-endian), followed by a trailing CRC32 over
// every preceding byte:
//
//	magic      uint32
//	version    uint16
//	reserved   uint16
//	generation uint64
//	count      uint32
//	entries    count * { pageID uint64, segment uint64, offset uint64, length uint32 }
//	crc32      uint32
const indexHeaderSize = 4 + 2 + 2 + 8 + 4
const indexEntrySize = 8 + 8 + 8 + 4

func indexPath(dir string, gen uint64) string {
	return filepath.Join(dir, fmt.Sprintf("index-%020d.idx", gen))
}

// writeIndexFile serializes idx for generation gen and publishes it
// atomically: tmp file -> fsync -> rename -> dir fsync.
func writeIndexFile(dir string, gen uint64, idx map[uint64]Location) error {
	ids := make([]uint64, 0, len(idx))
	for id := range idx {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })

	buf := make([]byte, 0, indexHeaderSize+len(ids)*indexEntrySize+4)
	header := make([]byte, indexHeaderSize)
	binary.LittleEndian.PutUint32(header[0:4], indexMagic)
	binary.LittleEndian.PutUint16(header[4:6], indexVersion)
	binary.LittleEndian.PutUint64(header[8:16], gen)
	binary.LittleEndian.PutUint32(header[16:20], uint32(len(ids)))
	buf = append(buf, header...)
	for _, id := range ids {
		loc := idx[id]
		entry := make([]byte, indexEntrySize)
		binary.LittleEndian.PutUint64(entry[0:8], id)
		binary.LittleEndian.PutUint64(entry[8:16], loc.Segment)
		binary.LittleEndian.PutUint64(entry[16:24], loc.Offset)
		binary.LittleEndian.PutUint32(entry[24:28], loc.Length)
		buf = append(buf, entry...)
	}
	sum := make([]byte, 4)
	binary.LittleEndian.PutUint32(sum, crc32.ChecksumIEEE(buf))
	buf = append(buf, sum...)

	tmp := indexPath(dir, gen) + ".tmp"
	if err := os.WriteFile(tmp, buf, 0o644); err != nil {
		return err
	}
	if err := syncFile(tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, indexPath(dir, gen)); err != nil {
		return err
	}
	return syncDir(dir)
}

// readIndexFile loads and validates the index published for generation gen.
func readIndexFile(dir string, gen uint64) (map[uint64]Location, error) {
	buf, err := os.ReadFile(indexPath(dir, gen))
	if err != nil {
		return nil, err
	}
	if len(buf) < indexHeaderSize+4 {
		return nil, fmt.Errorf("index gen %d: file too short", gen)
	}
	body, sumBytes := buf[:len(buf)-4], buf[len(buf)-4:]
	if crc32.ChecksumIEEE(body) != binary.LittleEndian.Uint32(sumBytes) {
		return nil, fmt.Errorf("index gen %d: checksum mismatch", gen)
	}
	if binary.LittleEndian.Uint32(body[0:4]) != indexMagic {
		return nil, fmt.Errorf("index gen %d: bad magic", gen)
	}
	if binary.LittleEndian.Uint16(body[4:6]) != indexVersion {
		return nil, fmt.Errorf("index gen %d: unsupported version", gen)
	}
	if binary.LittleEndian.Uint64(body[8:16]) != gen {
		return nil, fmt.Errorf("index gen %d: generation mismatch", gen)
	}
	count := binary.LittleEndian.Uint32(body[16:20])
	if len(body) != indexHeaderSize+int(count)*indexEntrySize {
		return nil, fmt.Errorf("index gen %d: truncated entries", gen)
	}
	idx := make(map[uint64]Location, count)
	off := indexHeaderSize
	for i := uint32(0); i < count; i++ {
		id := binary.LittleEndian.Uint64(body[off : off+8])
		idx[id] = Location{
			Segment: binary.LittleEndian.Uint64(body[off+8 : off+16]),
			Offset:  binary.LittleEndian.Uint64(body[off+16 : off+24]),
			Length:  binary.LittleEndian.Uint32(body[off+24 : off+28]),
		}
		off += indexEntrySize
	}
	return idx, nil
}
