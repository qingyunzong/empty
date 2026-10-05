// Package serialframe implements a streaming parser for a simple serial
// frame protocol:
//
//	magic(2) | length(2, LE) | seq(1) | payload(length) | crc16(2, LE)
//
// The CRC is CRC-16/IBM over length+seq+payload. The parser resynchronizes
// by re-searching from one byte after a failed magic, never allocates based
// on the untrusted length field, and keeps its retained buffer bounded by
// the maximum frame size.
package serialframe

import (
	"bytes"
	"encoding/binary"
)

const (
	Magic0    = 0xAA
	Magic1    = 0x55
	magicLen  = 2
	headerLen = magicLen + 2 + 1 // magic + length + seq
	crcLen    = 2
)

var magic = []byte{Magic0, Magic1}

// Frame is a successfully parsed frame.
type Frame struct {
	Seq     byte
	Payload []byte
}

// EncodeFrame builds the wire bytes for a frame.
func EncodeFrame(seq byte, payload []byte) []byte {
	out := make([]byte, 0, headerLen+len(payload)+crcLen)
	out = append(out, magic...)
	var tmp [2]byte
	binary.LittleEndian.PutUint16(tmp[:], uint16(len(payload)))
	out = append(out, tmp[:]...)
	out = append(out, seq)
	bodyStart := len(out) - 3 // length+seq
	out = append(out, payload...)
	crc := crc16IBM(out[bodyStart:])
	binary.LittleEndian.PutUint16(tmp[:], crc)
	out = append(out, tmp[:]...)
	return out
}

// Parser incrementally parses frames from arbitrary byte chunks.
type Parser struct {
	maxPayload int
	buf        []byte // retained, unprocessed bytes; len(buf) <= maxFrameSize after Feed
	// Discarded counts input bytes dropped as garbage (bytes before a magic,
	// bytes skipped after a bad CRC or an oversize length).
	Discarded int
}

// NewParser returns a Parser rejecting payloads larger than maxPayload.
func NewParser(maxPayload int) *Parser {
	return &Parser{maxPayload: maxPayload}
}

// MaxFrameSize is the largest possible retained buffer: a full valid frame.
func (p *Parser) MaxFrameSize() int { return headerLen + p.maxPayload + crcLen }

// Buffered reports how many unprocessed bytes are currently retained.
func (p *Parser) Buffered() int { return len(p.buf) }

// Feed consumes a chunk of input and returns any completed frames.
func (p *Parser) Feed(data []byte) []Frame {
	p.buf = append(p.buf, data...)
	var frames []Frame
	for {
		i := bytes.Index(p.buf, magic)
		if i < 0 {
			// No magic: drop everything except a tail that is a prefix
			// of the magic and could straddle the chunk boundary.
			keep := 0
			for k := magicLen - 1; k >= 1; k-- {
				if bytes.HasSuffix(p.buf, magic[:k]) {
					keep = k
					break
				}
			}
			if drop := len(p.buf) - keep; drop > 0 {
				p.Discarded += drop
				p.buf = p.buf[drop:]
			}
			break
		}
		if i > 0 {
			p.Discarded += i
			p.buf = p.buf[i:]
		}
		if len(p.buf) < headerLen {
			break // wait for the rest of the header
		}
		payloadLen := int(binary.LittleEndian.Uint16(p.buf[magicLen:headerLen]))
		if payloadLen > p.maxPayload {
			// Oversize length: skip only the first magic byte and rescan.
			// Nothing is allocated based on the untrusted length.
			p.Discarded++
			p.buf = p.buf[1:]
			continue
		}
		total := headerLen + payloadLen + crcLen
		if len(p.buf) < total {
			break // wait for the rest of the frame; total <= MaxFrameSize
		}
		body := p.buf[magicLen : headerLen+payloadLen]
		want := binary.LittleEndian.Uint16(p.buf[headerLen+payloadLen : total])
		if crc16IBM(body) != want {
			// Bad CRC: re-search from one byte after this magic, so a
			// magic inside the payload can still start the next frame.
			p.Discarded++
			p.buf = p.buf[1:]
			continue
		}
		payload := make([]byte, payloadLen)
		copy(payload, p.buf[headerLen:headerLen+payloadLen])
		frames = append(frames, Frame{Seq: p.buf[headerLen-1], Payload: payload})
		p.buf = p.buf[total:]
	}
	// Keep the retained buffer bounded: never hold a large backing array.
	if cap(p.buf) > p.MaxFrameSize() {
		nb := make([]byte, len(p.buf))
		copy(nb, p.buf)
		p.buf = nb
	}
	return frames
}

// crc16IBM computes CRC-16/IBM (reflected polynomial 0xA001, init 0x0000).
func crc16IBM(data []byte) uint16 {
	var crc uint16
	for _, b := range data {
		crc ^= uint16(b)
		for i := 0; i < 8; i++ {
			if crc&1 != 0 {
				crc = crc>>1 ^ 0xA001
			} else {
				crc >>= 1
			}
		}
	}
	return crc
}
