package dataeng

import (
	"encoding/binary"
	"fmt"
)

const (
	// HeaderSize is the fixed number of bytes before the compressed payload.
	HeaderSize = 13

	// MaxBlockWidth is the largest supported block width.
	MaxBlockWidth = 63

	// MaxCheckpointInterval is the largest supported checkpoint interval.
	MaxCheckpointInterval = 4096

	// MaxLength is the largest supported logical sequence length.
	MaxLength = uint64(1<<32 - 1)
)

// Encode builds the on-disk representation for bits.  Every element of bits
// must be exactly 0 or 1.
func Encode(bits []byte, b, S int) ([]byte, error) {
	if b < 1 || b > MaxBlockWidth {
		return nil, fmt.Errorf("%w: block width %d outside 1..%d",
			ErrInvalidParameter, b, MaxBlockWidth)
	}
	if S < 1 || S > MaxCheckpointInterval {
		return nil, fmt.Errorf("%w: checkpoint interval %d outside 1..%d",
			ErrInvalidParameter, S, MaxCheckpointInterval)
	}
	n := uint64(len(bits))
	if n > MaxLength {
		return nil, fmt.Errorf("%w: length %d exceeds %d",
			ErrInvalidParameter, n, MaxLength)
	}
	for i, v := range bits {
		if v > 1 {
			return nil, fmt.Errorf("%w at index %d: %d", ErrInvalidBit, i, v)
		}
	}

	header := make([]byte, HeaderSize)
	header[0] = byte(b)
	binary.LittleEndian.PutUint32(header[1:5], uint32(S))
	binary.LittleEndian.PutUint64(header[5:13], n)

	w := bitWriter{}
	cb := classWidth(b)
	blockCount := (n + uint64(b) - 1) / uint64(b)
	for blockIdx := uint64(0); blockIdx < blockCount; blockIdx++ {
		start := blockIdx * uint64(b)
		m := int(n - start)
		if m > b {
			m = b
		}

		c := 0
		var pattern uint64
		for j := 0; j < m; j++ {
			if bits[int(start)+j] != 0 {
				c++
				pattern |= uint64(1) << uint(m-1-j)
			}
		}

		ordinal, err := rankOrdinal(m, c, pattern)
		if err != nil {
			return nil, err
		}
		combinations := binomial(m, c)
		w.write(uint64(c), cb)
		w.write(ordinal, minWidth(combinations))
	}

	out := make([]byte, HeaderSize+len(w.buf))
	copy(out, header)
	copy(out[HeaderSize:], w.buf)
	return out, nil
}

// Open ingests an immutable byte snapshot, validates the entire wire format,
// then builds the checkpoint directory.  The snapshot is copied, so later
// caller mutation cannot alter the published index.
func Open(snapshot []byte) (*Index, error) {
	if len(snapshot) < HeaderSize {
		return nil, fmt.Errorf("%w: header needs %d bytes, got %d",
			ErrTruncated, HeaderSize, len(snapshot))
	}
	b := int(snapshot[0])
	S := binary.LittleEndian.Uint32(snapshot[1:5])
	n := binary.LittleEndian.Uint64(snapshot[5:13])

	if b < 1 || b > MaxBlockWidth {
		return nil, fmt.Errorf("%w: block width %d outside 1..%d",
			ErrMalformedHeader, b, MaxBlockWidth)
	}
	if S < 1 || S > MaxCheckpointInterval {
		return nil, fmt.Errorf("%w: checkpoint interval %d outside 1..%d",
			ErrMalformedHeader, S, MaxCheckpointInterval)
	}
	if n > MaxLength {
		return nil, fmt.Errorf("%w: length %d exceeds %d",
			ErrMalformedHeader, n, MaxLength)
	}

	payload := make([]byte, len(snapshot)-HeaderSize)
	copy(payload, snapshot[HeaderSize:])

	if n == 0 {
		if len(payload) != 0 {
			return nil, fmt.Errorf("%w: N=0 must have no payload, got %d bytes",
				ErrTrailingData, len(payload))
		}
		return &Index{
			b:       b,
			s:       S,
			n:       0,
			payload: payload,
			total:   0,
			dir:     nil,
		}, nil
	}

	blockCount := (n + uint64(b) - 1) / uint64(b)
	cb := classWidth(b)
	off := uint64(0)
	var ones uint64
	var dir []checkpoint

	for blockIdx := uint64(0); blockIdx < blockCount; blockIdx++ {
		start := blockIdx * uint64(b)
		m := int(n - start)
		if m > b {
			m = b
		}
		if blockIdx%uint64(S) == 0 {
			dir = append(dir, checkpoint{
				block:            blockIdx,
				logicalStart:     start,
				payloadBitOffset: off,
				onesBefore:       ones,
			})
		}

		classValue, err := readBits(payload, off, cb)
		if err != nil {
			return nil, fmt.Errorf("block %d class: %w", blockIdx, err)
		}
		off += uint64(cb)
		c := int(classValue)
		if c > m {
			return nil, fmt.Errorf("%w: block %d has c=%d > m=%d",
				ErrMalformedPayload, blockIdx, c, m)
		}

		combinations := binomial(m, c)
		width := minWidth(combinations)
		ordinal, err := readBits(payload, off, width)
		if err != nil {
			return nil, fmt.Errorf("block %d ordinal: %w", blockIdx, err)
		}
		off += uint64(width)
		if ordinal >= combinations {
			return nil, fmt.Errorf("%w: block %d ordinal %d >= C(%d,%d)=%d",
				ErrMalformedPayload, blockIdx, ordinal, m, c, combinations)
		}
		ones += uint64(c)
	}

	totalBits := uint64(len(payload)) * 8
	usedBytes := (off + 7) / 8
	if uint64(len(payload)) != usedBytes {
		if uint64(len(payload)) < usedBytes {
			return nil, fmt.Errorf("%w: stream needs %d bytes, has %d",
				ErrTruncated, usedBytes, len(payload))
		}
		return nil, fmt.Errorf("%w: stream uses %d bytes, snapshot has %d",
			ErrTrailingData, usedBytes, len(payload))
	}
	for p := off; p < totalBits; p++ {
		bit, err := payloadBit(payload, p)
		if err != nil {
			return nil, err
		}
		if bit != 0 {
			return nil, fmt.Errorf("%w: bit %d in final byte", ErrBadPadding, p)
		}
	}

	return &Index{
		b:       b,
		s:       S,
		n:       n,
		payload: payload,
		total:   ones,
		dir:     dir,
	}, nil
}

// New encodes bits and opens the resulting snapshot.
func New(bits []byte, b, S int) (*Index, error) {
	data, err := Encode(bits, b, S)
	if err != nil {
		return nil, err
	}
	return Open(data)
}
