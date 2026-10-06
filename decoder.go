package msglib

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// ErrPacketLengthOverflow reports a packet-length varint that overflows.
var ErrPacketLengthOverflow = errors.New("msglib: packet length varint overflow")

// Decoder reassembles length-prefixed packets from an arbitrarily chunked
// byte stream. Each packet on the wire is:
//
//	total   unsigned varint, byte count of the packet body
//	body    total bytes of tag-length-payload fields
//
// Feed accepts chunks of any size (including single bytes) and returns every
// packet completed so far. A malformed packet is rejected as a whole: Feed
// returns the error and the decoder must be discarded.
type Decoder struct {
	schema Schema
	buf    []byte
}

// NewDecoder returns a Decoder parsing packets with the given schema.
func NewDecoder(schema Schema) *Decoder {
	return &Decoder{schema: schema}
}

// Feed appends chunk to the internal buffer and returns all packets that
// became complete. A nil slice (and nil error) means more bytes are needed.
func (d *Decoder) Feed(chunk []byte) ([]*Message, error) {
	d.buf = append(d.buf, chunk...)
	var msgs []*Message
	for {
		total, n := binary.Uvarint(d.buf)
		switch {
		case n == 0:
			return msgs, nil // length prefix incomplete
		case n < 0:
			return nil, ErrPacketLengthOverflow
		}
		if uint64(len(d.buf)-n) < total {
			return msgs, nil // body incomplete
		}
		msg, err := Parse(d.buf[n:n+int(total)], d.schema)
		if err != nil {
			return nil, fmt.Errorf("msglib: rejecting packet: %w", err)
		}
		msgs = append(msgs, msg)
		d.buf = d.buf[n+int(total):]
	}
}

// EncodePacket frames a message as one length-prefixed packet.
func EncodePacket(m *Message) []byte {
	body := m.Encode()
	var out []byte
	var buf [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(buf[:], uint64(len(body)))
	out = append(out, buf[:n]...)
	return append(out, body...)
}
