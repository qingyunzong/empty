package store

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
	"os"
)

// On-disk record layout inside a segment file (all little-endian):
//
//	magic   uint32  recordMagic
//	pageID  uint64  stable page ID used by external references
//	length  uint32  payload length in bytes
//	crc32   uint32  IEEE checksum of payload
//	payload []byte
const (
	recordMagic      uint32 = 0x50414745 // "PAGE"
	recordHeaderSize        = 4 + 8 + 4 + 4
)

const (
	indexMagic   uint32 = 0x53494E44 // "SIND"
	indexVersion uint16 = 1
)

// Location pinpoints one record inside a segment file.
type Location struct {
	Segment uint64
	Offset  uint64
	Length  uint32 // total record length, header included
}

func encodeRecord(id uint64, payload []byte) []byte {
	buf := make([]byte, recordHeaderSize+len(payload))
	binary.LittleEndian.PutUint32(buf[0:4], recordMagic)
	binary.LittleEndian.PutUint64(buf[4:12], id)
	binary.LittleEndian.PutUint32(buf[12:16], uint32(len(payload)))
	binary.LittleEndian.PutUint32(buf[16:20], crc32.ChecksumIEEE(payload))
	copy(buf[recordHeaderSize:], payload)
	return buf
}

// readRecordAt reads and fully validates the record stored at off.
func readRecordAt(f *os.File, off uint64) (id uint64, payload []byte, total uint32, err error) {
	header := make([]byte, recordHeaderSize)
	if _, err = f.ReadAt(header, int64(off)); err != nil {
		return 0, nil, 0, fmt.Errorf("read header at %d: %w", off, err)
	}
	if binary.LittleEndian.Uint32(header[0:4]) != recordMagic {
		return 0, nil, 0, fmt.Errorf("bad record magic at %d", off)
	}
	id = binary.LittleEndian.Uint64(header[4:12])
	length := binary.LittleEndian.Uint32(header[12:16])
	wantCRC := binary.LittleEndian.Uint32(header[16:20])
	payload = make([]byte, length)
	if _, err = f.ReadAt(payload, int64(off)+recordHeaderSize); err != nil {
		return 0, nil, 0, fmt.Errorf("read payload at %d: %w", off, err)
	}
	if crc32.ChecksumIEEE(payload) != wantCRC {
		return 0, nil, 0, fmt.Errorf("checksum mismatch for page %d at %d", id, off)
	}
	return id, payload, recordHeaderSize + length, nil
}

// scanSegment walks every record of a segment file in order, verifying each
// page checksum, and invokes fn for each intact record.
func scanSegment(path string, fn func(id uint64, off uint64, total uint32) error) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	var off uint64
	for {
		header := make([]byte, recordHeaderSize)
		_, err := f.ReadAt(header, int64(off))
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return fmt.Errorf("scan %s at %d: %w", path, off, err)
		}
		if binary.LittleEndian.Uint32(header[0:4]) != recordMagic {
			return fmt.Errorf("scan %s: bad record magic at %d", path, off)
		}
		id := binary.LittleEndian.Uint64(header[4:12])
		length := binary.LittleEndian.Uint32(header[12:16])
		wantCRC := binary.LittleEndian.Uint32(header[16:20])
		payload := make([]byte, length)
		if _, err := f.ReadAt(payload, int64(off)+recordHeaderSize); err != nil {
			return fmt.Errorf("scan %s: truncated payload at %d: %w", path, off, err)
		}
		if crc32.ChecksumIEEE(payload) != wantCRC {
			return fmt.Errorf("scan %s: checksum mismatch for page %d at %d", path, id, off)
		}
		total := uint32(recordHeaderSize) + length
		if err := fn(id, off, total); err != nil {
			return err
		}
		off += uint64(total)
	}
}
