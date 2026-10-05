// Package auditlog implements an append-only audit log built from
// checksummed frames, together with crash recovery and a lagging index.
//
// Frame layout (all integers little-endian):
//
//	[0:4]   payload length in bytes (uint32)
//	[4:12]  sequence number (uint64)
//	[12:16] CRC-32 (IEEE) of the 12 header bytes above
//	[16:]   payload bytes
//	[end-4:] CRC-32 (IEEE) of header+payload (everything before it)
//
// The header checksum lets recovery distinguish a torn tail write (the
// file simply ends mid-frame) from in-place corruption of a length or
// sequence field: the former may be truncated, the latter never may.
package auditlog

import (
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"
	"io"
)

const (
	// HeaderLen is the size of the length+sequence+header-CRC prefix.
	HeaderLen = 4 + 8 + 4
	// CRCLen is the size of the trailing checksum.
	CRCLen = 4
	// MaxPayload bounds a single frame so a corrupt length field cannot
	// trigger absurd allocations.
	MaxPayload = 1 << 30
)

// Entry is one decoded frame.
type Entry struct {
	Seq     uint64
	Payload []byte
	Offset  int64 // byte offset of the frame within the log
}

// CorruptError reports bytes that are present but invalid (bad header
// checksum, implausible length, or bad frame checksum). Recovery must
// never rewrite the file when this occurs: only an incomplete tail
// frame may be truncated.
type CorruptError struct {
	Offset int64
	Reason string
}

func (e *CorruptError) Error() string {
	return fmt.Sprintf("auditlog: corrupt frame at offset %d: %s", e.Offset, e.Reason)
}

// IsCorrupt reports whether err is a CorruptError.
func IsCorrupt(err error) bool {
	var ce *CorruptError
	return errors.As(err, &ce)
}

// EncodeFrame serializes one frame.
func EncodeFrame(seq uint64, payload []byte) []byte {
	if len(payload) > MaxPayload {
		panic("auditlog: payload too large")
	}
	buf := make([]byte, HeaderLen+len(payload)+CRCLen)
	binary.LittleEndian.PutUint32(buf[0:4], uint32(len(payload)))
	binary.LittleEndian.PutUint64(buf[4:12], seq)
	binary.LittleEndian.PutUint32(buf[12:16], crc32.ChecksumIEEE(buf[0:12]))
	copy(buf[HeaderLen:], payload)
	crc := crc32.ChecksumIEEE(buf[:HeaderLen+len(payload)])
	binary.LittleEndian.PutUint32(buf[HeaderLen+len(payload):], crc)
	return buf
}

// Scan reads every complete frame from r (of total size n bytes).
//
// It returns the decoded entries and validLen, the number of leading
// bytes that form complete, well-checksummed frames. If the file ends
// mid-frame (a torn tail write), validLen is the offset where the
// incomplete frame begins and err is nil. If present bytes fail
// validation, err is a *CorruptError and validLen is the offset of the
// bad frame.
func Scan(r io.ReaderAt, n int64) (entries []Entry, validLen int64, err error) {
	var off int64
	for off < n {
		if n-off < HeaderLen+CRCLen {
			// Not enough bytes for even an empty frame: torn tail.
			return entries, off, nil
		}
		var hdr [HeaderLen]byte
		if _, err := r.ReadAt(hdr[:], off); err != nil {
			return entries, off, fmt.Errorf("auditlog: read header at %d: %w", off, err)
		}
		wantHCRC := binary.LittleEndian.Uint32(hdr[12:16])
		if got := crc32.ChecksumIEEE(hdr[0:12]); wantHCRC != got {
			return entries, off, &CorruptError{Offset: off, Reason: fmt.Sprintf("header checksum mismatch: stored %#08x, computed %#08x", wantHCRC, got)}
		}
		payloadLen := int64(binary.LittleEndian.Uint32(hdr[0:4]))
		if payloadLen > MaxPayload {
			return entries, off, &CorruptError{Offset: off, Reason: fmt.Sprintf("implausible payload length %d", payloadLen)}
		}
		frameLen := int64(HeaderLen) + payloadLen + CRCLen
		if n-off < frameLen {
			// Header intact but frame extends past EOF: torn tail.
			return entries, off, nil
		}
		frame := make([]byte, frameLen)
		if _, err := r.ReadAt(frame, off); err != nil {
			return entries, off, fmt.Errorf("auditlog: read frame at %d: %w", off, err)
		}
		want := binary.LittleEndian.Uint32(frame[frameLen-CRCLen:])
		got := crc32.ChecksumIEEE(frame[:frameLen-CRCLen])
		if want != got {
			return entries, off, &CorruptError{Offset: off, Reason: fmt.Sprintf("checksum mismatch: stored %#08x, computed %#08x", want, got)}
		}
		payload := make([]byte, payloadLen)
		copy(payload, frame[HeaderLen:HeaderLen+payloadLen])
		entries = append(entries, Entry{
			Seq:     binary.LittleEndian.Uint64(frame[4:12]),
			Payload: payload,
			Offset:  off,
		})
		off += frameLen
	}
	return entries, off, nil
}
