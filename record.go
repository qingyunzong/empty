// Package tailer implements a tail-following reader over a directory of
// append-only segment files containing variable-length records.
package tailer

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
)

// On-disk record layout (headerLen bytes header followed by payload):
//
//	magic   uint16  fixed 0x5A54 ("TZ")
//	length  uint32  payload length in bytes
//	crc32   uint32  IEEE CRC of the payload
//	payload []byte
const (
	magic     uint16 = 0x5A54
	headerLen        = 2 + 4 + 4
)

// MaxPayload bounds a single record payload so a corrupt length field
// cannot trigger a huge allocation.
const MaxPayload = 64 << 20

// EncodeRecord serializes payload into its on-disk representation.
func EncodeRecord(payload []byte) []byte {
	buf := make([]byte, headerLen+len(payload))
	binary.LittleEndian.PutUint16(buf[0:2], magic)
	binary.LittleEndian.PutUint32(buf[2:6], uint32(len(payload)))
	binary.LittleEndian.PutUint32(buf[6:10], crc32.ChecksumIEEE(payload))
	copy(buf[headerLen:], payload)
	return buf
}

// errNeedMore is returned by decodeRecord when buf holds only a prefix of a
// record (an incomplete tail).
var errNeedMore = errors.New("tailer: incomplete record")

// decodeRecord parses one record from the front of buf. It returns
// errNeedMore if buf does not yet hold a full record, and a descriptive
// error if the bytes are provably corrupt.
func decodeRecord(buf []byte) (payload []byte, total int, err error) {
	if len(buf) < 2 {
		return nil, 0, errNeedMore
	}
	if binary.LittleEndian.Uint16(buf[0:2]) != magic {
		return nil, 0, fmt.Errorf("tailer: bad magic %#x", binary.LittleEndian.Uint16(buf[0:2]))
	}
	if len(buf) < headerLen {
		return nil, 0, errNeedMore
	}
	n := binary.LittleEndian.Uint32(buf[2:6])
	if n > MaxPayload {
		return nil, 0, fmt.Errorf("tailer: payload length %d exceeds limit", n)
	}
	total = headerLen + int(n)
	if len(buf) < total {
		return nil, 0, errNeedMore
	}
	payload = buf[headerLen:total]
	if crc32.ChecksumIEEE(payload) != binary.LittleEndian.Uint32(buf[6:10]) {
		return nil, 0, fmt.Errorf("tailer: crc mismatch at record of %d payload bytes", n)
	}
	return payload, total, nil
}
