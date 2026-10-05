package store

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"os"
)

// The index resolves stable page IDs to physical locations. It is stored as
// an append-only log per generation: idx-<generation>.log
//
//	header: magic uint32 ("SIDX") + generation uint64   (12 bytes)
//	entry:  pageID uint64 + segment uint64 + offset uint64 + length uint32
//	        + crc32 uint32 (over the 28 payload bytes)   (32 bytes)
//
// Later entries for the same page ID override earlier ones. A torn tail
// entry (short read or bad CRC) ends the replay, matching what a crash
// mid-append would leave behind.
const (
	indexMagic       uint32 = 0x53494458 // "SIDX"
	indexHeaderSize         = 12
	indexEntrySize          = 32
)

type indexEntry struct {
	PageID uint64
	Loc    Location
}

func indexFileName(generation uint64) string {
	return fmt.Sprintf("idx-%06d.log", generation)
}

// encodeIndexEntry serializes one entry with its trailing CRC32.
func encodeIndexEntry(e indexEntry) []byte {
	buf := make([]byte, indexEntrySize)
	binary.LittleEndian.PutUint64(buf[0:8], e.PageID)
	binary.LittleEndian.PutUint64(buf[8:16], e.Loc.Segment)
	binary.LittleEndian.PutUint64(buf[16:24], e.Loc.Offset)
	binary.LittleEndian.PutUint32(buf[24:28], e.Loc.Length)
	binary.LittleEndian.PutUint32(buf[28:32], crc32.ChecksumIEEE(buf[:28]))
	return buf
}

// writeIndexHeader initializes a fresh (empty) index log for a generation.
func writeIndexHeader(f *os.File, generation uint64) error {
	buf := make([]byte, indexHeaderSize)
	binary.LittleEndian.PutUint32(buf[0:4], indexMagic)
	binary.LittleEndian.PutUint64(buf[4:12], generation)
	if _, err := f.Write(buf); err != nil {
		return err
	}
	return nil
}

// appendIndexEntry appends one entry to an open index log.
func appendIndexEntry(f *os.File, e indexEntry) error {
	if _, err := f.Write(encodeIndexEntry(e)); err != nil {
		return err
	}
	return f.Sync()
}

// loadIndex replays an index log, stopping at the first torn or corrupt
// tail entry. Entries are returned in log order.
func loadIndex(path string) (generation uint64, entries []indexEntry, err error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, nil, err
	}
	defer f.Close()

	header := make([]byte, indexHeaderSize)
	if _, err := io.ReadFull(f, header); err != nil {
		return 0, nil, fmt.Errorf("store: reading index header: %w", err)
	}
	if binary.LittleEndian.Uint32(header[0:4]) != indexMagic {
		return 0, nil, fmt.Errorf("store: bad index magic in %s", path)
	}
	generation = binary.LittleEndian.Uint64(header[4:12])

	buf := make([]byte, indexEntrySize)
	for {
		if _, err := io.ReadFull(f, buf); err != nil {
			// EOF or torn tail: both end the replay.
			break
		}
		want := binary.LittleEndian.Uint32(buf[28:32])
		if crc32.ChecksumIEEE(buf[:28]) != want {
			break
		}
		entries = append(entries, indexEntry{
			PageID: binary.LittleEndian.Uint64(buf[0:8]),
			Loc: Location{
				Segment: binary.LittleEndian.Uint64(buf[8:16]),
				Offset:  binary.LittleEndian.Uint64(buf[16:24]),
				Length:  binary.LittleEndian.Uint32(buf[24:28]),
			},
		})
	}
	return generation, entries, nil
}
