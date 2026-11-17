package formal

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"math"
)

const (
	formatVersion = uint16(1)

	groupMagic  = "GCG1"
	recordMagic = "GCR1"
	footerMagic = "GCF1"

	groupHeaderSize  = 40
	recordHeaderSize = 32
	groupFooterSize  = 24
)

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

// A group is:
//
//	group header
//	record header + payload (repeated)
//	group footer (generation, total length, CRC of the entire group)
//
// The footer is part of the checksummed extent, so a torn group can never be
// accepted. Every record also carries its absolute start offset. Recovery
// requires both that offset and the group generation to match the location
// being scanned, which prevents stale bytes from an earlier failed group from
// being mistaken for a later successful group.
type encodedGroup struct {
	data      []byte
	recordLSN []LSN
	end       LSN
}

func encodeGroup(generation uint64, start LSN, records []*commitWaiter) (encodedGroup, error) {
	total := groupHeaderSize + groupFooterSize
	payloadBytes := uint64(0)
	for _, rec := range records {
		size := recordHeaderSize + len(rec.payload)
		if size < recordHeaderSize {
			return encodedGroup{}, errors.New("formal: record size overflow")
		}
		total += size
		payloadBytes += uint64(len(rec.payload))
		if total > math.MaxUint32 {
			return encodedGroup{}, errors.New("formal: commit group exceeds format limit")
		}
	}
	if total < groupHeaderSize+groupFooterSize {
		return encodedGroup{}, errors.New("formal: commit group size overflow")
	}
	if payloadBytes > math.MaxUint32 {
		return encodedGroup{}, errors.New("formal: payload exceeds format limit")
	}

	buf := make([]byte, total)
	copy(buf[0:4], groupMagic)
	binary.LittleEndian.PutUint16(buf[4:6], formatVersion)
	binary.LittleEndian.PutUint16(buf[6:8], groupHeaderSize)
	binary.LittleEndian.PutUint64(buf[8:16], generation)
	binary.LittleEndian.PutUint64(buf[16:24], uint64(start))
	binary.LittleEndian.PutUint32(buf[24:28], uint32(total))
	binary.LittleEndian.PutUint32(buf[28:32], uint32(len(records)))
	binary.LittleEndian.PutUint32(buf[32:36], uint32(payloadBytes))
	binary.LittleEndian.PutUint32(buf[36:40], crc32.Checksum(buf[0:36], castagnoli))

	recordLSN := make([]LSN, 0, len(records))
	off := groupHeaderSize
	for _, rec := range records {
		recordLSN = append(recordLSN, LSN(uint64(start)+uint64(off)))
		copy(buf[off:off+4], recordMagic)
		binary.LittleEndian.PutUint16(buf[off+4:off+6], formatVersion)
		binary.LittleEndian.PutUint16(buf[off+6:off+8], 0)
		binary.LittleEndian.PutUint64(buf[off+8:off+16], rec.txID)
		binary.LittleEndian.PutUint64(buf[off+16:off+24], uint64(start)+uint64(off))
		binary.LittleEndian.PutUint32(buf[off+24:off+28], uint32(len(rec.payload)))
		binary.LittleEndian.PutUint32(buf[off+28:off+32], crc32.Checksum(rec.payload, castagnoli))
		copy(buf[off+recordHeaderSize:], rec.payload)
		off += recordHeaderSize + len(rec.payload)
	}
	if off+groupFooterSize != total {
		return encodedGroup{}, errors.New("formal: internal group size mismatch")
	}

	copy(buf[off:off+4], footerMagic)
	binary.LittleEndian.PutUint16(buf[off+4:off+6], formatVersion)
	binary.LittleEndian.PutUint16(buf[off+6:off+8], 0)
	binary.LittleEndian.PutUint64(buf[off+8:off+16], generation)
	binary.LittleEndian.PutUint32(buf[off+16:off+20], uint32(total))
	binary.LittleEndian.PutUint32(buf[off+20:off+24], crc32.Checksum(buf[0:off+20], castagnoli))

	return encodedGroup{
		data:      buf,
		recordLSN: recordLSN,
		end:       LSN(uint64(start) + uint64(total)),
	}, nil
}

type decodedRecord struct {
	txID    uint64
	payload []byte
	start   LSN
	end     LSN
}

func decodeGroup(buf []byte, off LSN) ([]decodedRecord, uint64, int64, error) {
	if len(buf) < groupHeaderSize+groupFooterSize {
		return nil, 0, 0, ErrCorruptGroup
	}
	if string(buf[0:4]) != groupMagic {
		return nil, 0, 0, ErrCorruptGroup
	}
	if binary.LittleEndian.Uint16(buf[4:6]) != formatVersion {
		return nil, 0, 0, ErrCorruptGroup
	}
	if binary.LittleEndian.Uint16(buf[6:8]) != groupHeaderSize {
		return nil, 0, 0, ErrCorruptGroup
	}
	if binary.LittleEndian.Uint32(buf[36:40]) != crc32.Checksum(buf[0:36], castagnoli) {
		return nil, 0, 0, ErrCorruptGroup
	}

	generation := binary.LittleEndian.Uint64(buf[8:16])
	start := binary.LittleEndian.Uint64(buf[16:24])
	total := binary.LittleEndian.Uint32(buf[24:28])
	count := binary.LittleEndian.Uint32(buf[28:32])
	payloadBytes := binary.LittleEndian.Uint32(buf[32:36])
	if generation == 0 || start != uint64(off) {
		return nil, 0, 0, ErrCorruptGroup
	}
	if total < groupHeaderSize+groupFooterSize || int(total) != len(buf) {
		return nil, 0, 0, ErrCorruptGroup
	}
	if int(count) > (len(buf)-groupHeaderSize-groupFooterSize)/recordHeaderSize {
		return nil, 0, 0, ErrCorruptGroup
	}

	footer := len(buf) - groupFooterSize
	if string(buf[footer:footer+4]) != footerMagic {
		return nil, 0, 0, ErrCorruptGroup
	}
	if binary.LittleEndian.Uint16(buf[footer+4:footer+6]) != formatVersion {
		return nil, 0, 0, ErrCorruptGroup
	}
	if binary.LittleEndian.Uint64(buf[footer+8:footer+16]) != generation {
		return nil, 0, 0, ErrCorruptGroup
	}
	if binary.LittleEndian.Uint32(buf[footer+16:footer+20]) != total {
		return nil, 0, 0, ErrCorruptGroup
	}
	if binary.LittleEndian.Uint32(buf[footer+20:footer+24]) != crc32.Checksum(buf[0:footer+20], castagnoli) {
		return nil, 0, 0, ErrCorruptGroup
	}

	records := make([]decodedRecord, 0, count)
	pos := groupHeaderSize
	var decodedPayloadBytes uint64
	for i := uint32(0); i < count; i++ {
		if pos+recordHeaderSize > footer {
			return nil, 0, 0, ErrCorruptGroup
		}
		if string(buf[pos:pos+4]) != recordMagic {
			return nil, 0, 0, ErrCorruptGroup
		}
		if binary.LittleEndian.Uint16(buf[pos+4:pos+6]) != formatVersion {
			return nil, 0, 0, ErrCorruptGroup
		}
		txID := binary.LittleEndian.Uint64(buf[pos+8 : pos+16])
		recordStart := binary.LittleEndian.Uint64(buf[pos+16 : pos+24])
		payloadLen := binary.LittleEndian.Uint32(buf[pos+24 : pos+28])
		payloadCRC := binary.LittleEndian.Uint32(buf[pos+28 : pos+32])
		body := pos + recordHeaderSize
		if uint64(body)+uint64(payloadLen) > uint64(footer) {
			return nil, 0, 0, ErrCorruptGroup
		}
		if recordStart != uint64(off)+uint64(pos) {
			return nil, 0, 0, ErrCorruptGroup
		}
		payload := buf[body : body+int(payloadLen)]
		if crc32.Checksum(payload, castagnoli) != payloadCRC {
			return nil, 0, 0, ErrCorruptGroup
		}
		records = append(records, decodedRecord{
			txID:    txID,
			payload: payload,
			start:   LSN(recordStart),
			end:     LSN(uint64(off) + uint64(body) + uint64(payloadLen)),
		})
		decodedPayloadBytes += uint64(payloadLen)
		pos = body + int(payloadLen)
	}
	if pos != footer {
		return nil, 0, 0, fmt.Errorf("%w: trailing bytes in group", ErrCorruptGroup)
	}
	if decodedPayloadBytes != uint64(payloadBytes) {
		return nil, 0, 0, ErrCorruptGroup
	}
	return records, generation, int64(total), nil
}
