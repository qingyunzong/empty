package q154

import (
	"encoding/binary"
	"errors"
	"hash"
	"hash/crc32"
	"io"
)

var (
	// ErrTruncated reports that a frame ended before all declared fields,
	// padding bits and the checksum had been read.
	ErrTruncated = errors.New("q154: truncated frame")
	// ErrCRC reports that the stored CRC32-IEEE checksum does not match.
	ErrCRC = errors.New("q154: checksum mismatch")
	// ErrLEB128 reports a non-shortest signed LEB128 encoding or one that
	// does not fit in a signed 64-bit integer.
	ErrLEB128 = errors.New("q154: invalid signed LEB128")
	// ErrWidth reports a significant-bit width that does not fit in the
	// 64-bit value together with the declared leading-zero count.
	ErrWidth = errors.New("q154: significant width out of range")
	// ErrOverflow reports a timestamp that does not fit in int64.
	ErrOverflow = errors.New("q154: timestamp overflow")
	// ErrPadding reports non-zero padding bits in the final partial byte.
	ErrPadding = errors.New("q154: non-zero padding bits")
)

// Record is one decoded sensor sample. Value carries the raw 64-bit payload;
// callers may reinterpret it with math.Float64frombits when appropriate.
type Record struct {
	Timestamp int64
	Value     uint64
}

// Visitor receives the records of a fully validated frame. Returning an
// error aborts delivery and is propagated by DecodeFrame.
type Visitor func(Record) error

// Decoder reads frames from an underlying byte stream, preserving bit-level
// state when the stream is split across arbitrarily sized transport blocks.
type Decoder struct {
	crc hashReader
	br  bitReader
}

// NewDecoder returns a Decoder reading frames from r.
func NewDecoder(r io.Reader) *Decoder {
	d := &Decoder{}
	d.crc = hashReader{r: r, h: crc32.NewIEEE()}
	d.br = bitReader{body: &d.crc, raw: r}
	return d
}

// DecodeFrame reads and validates one frame and calls visit for every record
// only after the checksum has been verified. io.EOF is returned unchanged at
// a clean frame boundary; any partially available frame yields ErrTruncated.
func (d *Decoder) DecodeFrame(visit Visitor) error {
	d.crc.h.Reset()

	header, err := d.br.readFrameHeader()
	if err != nil {
		return err
	}
	count := binary.BigEndian.Uint32(header)

	records := make([]Record, 0, min(count, 16))

	var (
		ts      int64
		delta   int64
		lastVal uint64
	)
	for i := uint32(0); i < count; i++ {
		if i == 0 {
			ts, err = d.br.readInt64()
			if err != nil {
				return err
			}
			lastVal, err = d.br.readUint64()
			if err != nil {
				return err
			}
			records = append(records, Record{Timestamp: ts, Value: lastVal})
			continue
		}

		flag, err := d.br.readBits(1)
		if err != nil {
			return err
		}
		if flag == 1 {
			dod, err := d.br.readSLEB128()
			if err != nil {
				return err
			}
			next, ok := addInt64(delta, dod)
			if !ok {
				return ErrOverflow
			}
			delta = next
		}
		nextTS, ok := addInt64(ts, delta)
		if !ok {
			return ErrOverflow
		}
		ts = nextTS

		same, err := d.br.readBits(1)
		if err != nil {
			return err
		}
		if same == 1 {
			leading, err := d.br.readBits(6)
			if err != nil {
				return err
			}
			widthField, err := d.br.readBits(6)
			if err != nil {
				return err
			}
			width := int(widthField)
			if width == 0 {
				width = 64
			}
			if leading+uint64(width) > 64 {
				return ErrWidth
			}
			significant, err := d.br.readBits(uint(width))
			if err != nil {
				return err
			}
			xor := significant << (64 - uint(leading) - uint(width))
			lastVal ^= xor
		}
		records = append(records, Record{Timestamp: ts, Value: lastVal})
	}

	padding, err := d.br.alignByte()
	if err != nil {
		return err
	}
	if padding != 0 {
		return ErrPadding
	}

	trailer, err := d.br.readTrailer(4)
	if err != nil {
		return err
	}
	want := binary.BigEndian.Uint32(trailer)
	if d.crc.h.Sum32() != want {
		return ErrCRC
	}

	if visit != nil {
		for _, rec := range records {
			if err := visit(rec); err != nil {
				return err
			}
		}
	}
	return nil
}

// hashReader feeds every byte read through a running CRC32 checksum.
type hashReader struct {
	r io.Reader
	h hash.Hash32
}

func (c *hashReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	if n > 0 {
		c.h.Write(p[:n])
	}
	return n, err
}

// bitReader reads most-significant-bit-first values from a byte stream while
// retaining partial-byte state across Read calls and transport blocks.
type bitReader struct {
	body  io.Reader
	raw   io.Reader
	cache byte
	bits  uint
}

// readFrameHeader is the only read allowed to surface a clean io.EOF, since
// it is the first read of a frame and may simply find an exhausted stream.
func (b *bitReader) readFrameHeader() ([]byte, error) {
	if b.bits != 0 {
		return nil, ErrPadding
	}
	out := make([]byte, 4)
	if _, err := io.ReadFull(b.body, out); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, io.EOF
		}
		return nil, ErrTruncated
	}
	return out, nil
}

// readTrailer reads bytes excluded from the checksum directly from the
// underlying stream.
func (b *bitReader) readTrailer(n int) ([]byte, error) {
	if b.bits != 0 {
		return nil, ErrPadding
	}
	out := make([]byte, n)
	if _, err := io.ReadFull(b.raw, out); err != nil {
		return nil, ErrTruncated
	}
	return out, nil
}

func (b *bitReader) readByte() (byte, error) {
	var out [1]byte
	if _, err := io.ReadFull(b.body, out[:]); err != nil {
		return 0, ErrTruncated
	}
	return out[0], nil
}

func (b *bitReader) readBits(n uint) (uint64, error) {
	var v uint64
	for n > 0 {
		if b.bits == 0 {
			next, err := b.readByte()
			if err != nil {
				return 0, err
			}
			b.cache = next
			b.bits = 8
		}
		take := min(n, b.bits)
		shift := b.bits - take
		v = v<<take | uint64((b.cache>>shift)&((1<<take)-1))
		b.bits -= take
		n -= take
	}
	return v, nil
}

func (b *bitReader) readUint64() (uint64, error) {
	return b.readBits(64)
}

func (b *bitReader) readInt64() (int64, error) {
	v, err := b.readBits(64)
	return int64(v), err
}

// alignByte discards the bits remaining in the current partial byte and
// returns their value so callers can enforce zero padding.
func (b *bitReader) alignByte() (uint64, error) {
	if b.bits == 0 {
		return 0, nil
	}
	remaining := b.bits
	v, err := b.readBits(remaining)
	if err != nil {
		return 0, err
	}
	return v, nil
}

// readSLEB128 reads a canonical signed LEB128 integer, rejecting redundant
// encodings and values that overflow a signed 64-bit result.
func (b *bitReader) readSLEB128() (int64, error) {
	var result uint64
	var shift uint
	var raw []byte
	for byteIndex := 0; ; byteIndex++ {
		if byteIndex == 10 {
			return 0, ErrLEB128
		}
		chunk, err := b.readBits(8)
		if err != nil {
			return 0, err
		}
		payload := chunk & 0x7f
		continuation := chunk&0x80 != 0

		if byteIndex == 9 && (continuation || (payload != 0x00 && payload != 0x7f)) {
			return 0, ErrLEB128
		}
		raw = append(raw, byte(chunk))

		result |= payload << shift
		shift += 7

		if !continuation {
			if payload&0x40 != 0 && shift < 64 {
				for ; shift < 64; shift++ {
					result |= 1 << shift
				}
			}
			value := int64(result)
			if len(appendSLEB128(nil, value)) != len(raw) {
				return 0, ErrLEB128
			}
			return value, nil
		}
	}
}

// appendSLEB128 returns the unique shortest signed LEB128 encoding of v.
func appendSLEB128(dst []byte, v int64) []byte {
	for {
		b := byte(v & 0x7f)
		signBitSet := b&0x40 != 0
		v >>= 7
		if (v == 0 && !signBitSet) || (v == -1 && signBitSet) {
			return append(dst, b)
		}
		dst = append(dst, b|0x80)
	}
}

func addInt64(a, b int64) (int64, bool) {
	sum := uint64(a) + uint64(b)
	signed := int64(sum)
	if (a >= 0 && b >= 0 && signed < 0) || (a < 0 && b < 0 && signed >= 0) {
		return 0, false
	}
	return signed, true
}
