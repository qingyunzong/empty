package statestore

import (
	"encoding/binary"
	"errors"
	"hash/crc32"
	"io"
)

// frameMagic marks the start of a commit frame ("STAT").
const frameMagic uint32 = 0x53544154

// frameHeaderLen = magic(4) + payloadLen(4) + version(8)
const frameHeaderLen = 16

const frameCRCLen = 4

// record is a single committed update recovered from the log.
type record struct {
	version uint64
	payload []byte
}

// encodeFrame serializes one commit frame:
// magic | payloadLen | version | payload | crc32(magic..payload)
func encodeFrame(version uint64, payload []byte) []byte {
	frame := make([]byte, 0, frameHeaderLen+len(payload)+frameCRCLen)
	var hdr [frameHeaderLen]byte
	binary.LittleEndian.PutUint32(hdr[0:4], frameMagic)
	binary.LittleEndian.PutUint32(hdr[4:8], uint32(len(payload)))
	binary.LittleEndian.PutUint64(hdr[8:16], version)
	frame = append(frame, hdr[:]...)
	frame = append(frame, payload...)
	var crcb [frameCRCLen]byte
	binary.LittleEndian.PutUint32(crcb[:], crc32.ChecksumIEEE(frame))
	frame = append(frame, crcb[:]...)
	return frame
}

// replay scans r and returns every complete, checksum-valid commit frame in
// order. A torn tail (short header, short payload, bad magic, or CRC
// mismatch) stops the scan silently: only fully committed frames count.
func replay(r io.Reader) ([]record, error) {
	var records []record
	var hdr [frameHeaderLen]byte
	for {
		_, err := io.ReadFull(r, hdr[:])
		if errors.Is(err, io.EOF) {
			return records, nil // clean end at a frame boundary
		}
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return records, nil // torn header from a crashed/short write
		}
		if err != nil {
			return nil, err
		}
		if binary.LittleEndian.Uint32(hdr[0:4]) != frameMagic {
			return records, nil // garbage tail; stop
		}
		payloadLen := binary.LittleEndian.Uint32(hdr[4:8])
		version := binary.LittleEndian.Uint64(hdr[8:16])
		rest := make([]byte, int(payloadLen)+frameCRCLen)
		if _, err := io.ReadFull(r, rest); err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				return records, nil // torn payload/crc
			}
			return nil, err
		}
		payload, crcb := rest[:payloadLen], rest[payloadLen:]
		crcInput := make([]byte, 0, frameHeaderLen+len(payload))
		crcInput = append(crcInput, hdr[:]...)
		crcInput = append(crcInput, payload...)
		if binary.LittleEndian.Uint32(crcb) != crc32.ChecksumIEEE(crcInput) {
			return records, nil // corrupted frame; stop
		}
		records = append(records, record{version: version, payload: payload})
	}
}
