package main

import (
	"encoding/binary"
	"fmt"
	"hash/crc32"
	"io"
)

// On-disk frame layout (all integers big-endian):
//
//	+--------+--------+---------+----------+=========+--------+
//	| uint32 | uint32 | uint64  | uint32   | payload | uint32 |
//	| magic  | length | seq     | hdrCRC32 |         | CRC-32 |
//	+--------+--------+---------+----------+=========+--------+
//
// hdrCRC32 covers magic+length+seq; the trailing CRC-32 (IEEE) covers the
// whole 20-byte header plus the payload. The header checksum lets the
// scanner distinguish a torn write (incomplete bytes at the tail) from
// in-place corruption of the length field (complete bytes, bad header CRC).
const (
	frameMagic    = 0x414C4F47 // "ALOG"
	headerSize    = 20         // magic + length + seq + header CRC
	trailerSize   = 4          // uint32 CRC-32 (IEEE)
	maxPayloadLen = 64 << 20
)

// Frame is a single decoded audit record.
type Frame struct {
	Offset  int64
	Seq     uint64
	Payload []byte
}

// CorruptError reports a complete frame (or frame header) whose checksum
// does not match. Recovery must never modify the log when this error
// occurs; only incomplete tail frames may be truncated.
type CorruptError struct {
	Offset int64
	Seq    uint64
	Reason string
}

func (e *CorruptError) Error() string {
	return fmt.Sprintf("%s in frame at offset %d (seq %d)", e.Reason, e.Offset, e.Seq)
}

func encodeFrame(seq uint64, payload []byte) []byte {
	buf := make([]byte, headerSize+len(payload)+trailerSize)
	binary.BigEndian.PutUint32(buf[0:4], frameMagic)
	binary.BigEndian.PutUint32(buf[4:8], uint32(len(payload)))
	binary.BigEndian.PutUint64(buf[8:16], seq)
	binary.BigEndian.PutUint32(buf[16:20], crc32.ChecksumIEEE(buf[0:16]))
	copy(buf[headerSize:], payload)
	crc := crc32.ChecksumIEEE(buf[:headerSize+len(payload)])
	binary.BigEndian.PutUint32(buf[headerSize+len(payload):], crc)
	return buf
}

// scanFrames decodes frames from r until EOF. It returns the decoded frames
// and goodEnd, the number of bytes covered by complete, valid frames.
//
// A trailing run of bytes that does not form a complete frame (a torn
// write) is not an error; goodEnd marks where the valid data ends so the
// caller may truncate it. Any complete-but-invalid frame or header yields
// *CorruptError.
func scanFrames(r io.Reader) (frames []Frame, goodEnd int64, err error) {
	var off int64
	hdr := make([]byte, headerSize)
	for {
		if _, e := io.ReadFull(r, hdr); e != nil {
			if e == io.EOF || e == io.ErrUnexpectedEOF {
				return frames, off, nil
			}
			return frames, off, e
		}
		length := binary.BigEndian.Uint32(hdr[4:8])
		seq := binary.BigEndian.Uint64(hdr[8:16])
		if binary.BigEndian.Uint32(hdr[0:4]) != frameMagic ||
			binary.BigEndian.Uint32(hdr[16:20]) != crc32.ChecksumIEEE(hdr[0:16]) ||
			length > maxPayloadLen {
			return frames, off, &CorruptError{Offset: off, Seq: seq, Reason: "header checksum mismatch"}
		}
		body := make([]byte, int64(length)+trailerSize)
		if _, e := io.ReadFull(r, body); e != nil {
			if e == io.EOF || e == io.ErrUnexpectedEOF {
				return frames, off, nil
			}
			return frames, off, e
		}
		h := crc32.NewIEEE()
		h.Write(hdr)
		h.Write(body[:length])
		if binary.BigEndian.Uint32(body[length:]) != h.Sum32() {
			return frames, off, &CorruptError{Offset: off, Seq: seq, Reason: "checksum mismatch"}
		}
		frames = append(frames, Frame{Offset: off, Seq: seq, Payload: body[:length]})
		off += headerSize + int64(length) + trailerSize
	}
}
