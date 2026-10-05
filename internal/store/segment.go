package store

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
)

// On-disk record layout inside a segment file:
//
//	magic   uint32  (4 bytes, "PAGE")
//	pageID  uint64  (8 bytes)
//	length  uint32  (4 bytes, payload length)
//	payload []byte  (length bytes)
//	crc32   uint32  (4 bytes, IEEE over magic..payload)
const (
	recordMagic       uint32 = 0x50414745 // "PAGE"
	recordHeaderSize        = 16
	recordTrailerSize       = 4
)

// Location pinpoints one record inside a segment file. External users only
// ever hold the stable page ID; the Location is an internal, per-generation
// resolution of that ID.
type Location struct {
	Segment uint64
	Offset  uint64
	Length  uint32
}

var errBadRecord = errors.New("store: corrupt record")

// encodeRecord serializes one page record including its CRC32 checksum.
func encodeRecord(pageID uint64, payload []byte) []byte {
	buf := make([]byte, recordHeaderSize+len(payload)+recordTrailerSize)
	binary.LittleEndian.PutUint32(buf[0:4], recordMagic)
	binary.LittleEndian.PutUint64(buf[4:12], pageID)
	binary.LittleEndian.PutUint32(buf[12:16], uint32(len(payload)))
	copy(buf[recordHeaderSize:], payload)
	crc := crc32.ChecksumIEEE(buf[:recordHeaderSize+len(payload)])
	binary.LittleEndian.PutUint32(buf[recordHeaderSize+len(payload):], crc)
	return buf
}

// decodeRecord validates magic and checksum, returning the page ID and a
// copy of the payload.
func decodeRecord(buf []byte) (uint64, []byte, error) {
	if len(buf) < recordHeaderSize+recordTrailerSize {
		return 0, nil, errBadRecord
	}
	if binary.LittleEndian.Uint32(buf[0:4]) != recordMagic {
		return 0, nil, errBadRecord
	}
	pageID := binary.LittleEndian.Uint64(buf[4:12])
	length := binary.LittleEndian.Uint32(buf[12:16])
	if uint64(len(buf)) != uint64(recordHeaderSize)+uint64(length)+recordTrailerSize {
		return 0, nil, errBadRecord
	}
	want := binary.LittleEndian.Uint32(buf[recordHeaderSize+length:])
	got := crc32.ChecksumIEEE(buf[:recordHeaderSize+length])
	if want != got {
		return 0, nil, fmt.Errorf("store: checksum mismatch on page %d", pageID)
	}
	payload := make([]byte, length)
	copy(payload, buf[recordHeaderSize:recordHeaderSize+length])
	return pageID, payload, nil
}
