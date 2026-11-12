// Package steim decodes big-endian Steim-1 and Steim-2 compressed
// record bodies into complete int32 sample sequences.
//
// A Decoder models exactly one record. The compressed body may arrive
// through an arbitrary sequence of Push calls (any chunk boundaries),
// and Finish delivers the decoded samples exactly once. Every error is
// terminal: a failed decoder can never be resubmitted, and a delivered
// decoder cannot deliver twice. A record that is truncated, exceeds the
// host sample limit, or contains any illegal control combination is
// rejected as a whole; partial sample sequences are never returned.
//
// Provenance indices are zero based. For every emitted sample, Frame
// and Word identify the 32-bit word that produced it and Diff is the
// ordinal of the difference inside that word. The first sample X0 is
// not a difference: it is marked as frame 0, word 1, Diff -1. The
// skipped bridge difference d0 never becomes a sample and is never
// counted in the sample index.
package steim

import (
	"encoding/binary"
	"errors"
)

// Sentinel errors returned by the decoder. All errors are terminal.
var (
	// ErrInvalidMetadata means encoding, N or L fails the metadata rules.
	ErrInvalidMetadata = errors.New("steim: invalid record metadata")
	// ErrOverflow means the declared sample count exceeds the host limit.
	ErrOverflow = errors.New("steim: sample count exceeds host limit")
	// ErrTooLarge means Push carried bytes past the declared body length.
	ErrTooLarge = errors.New("steim: pushed past declared compressed body length")
	// ErrTruncated means Finish was called before all L bytes arrived.
	ErrTruncated = errors.New("steim: compressed body shorter than declared length")
	// ErrCorrupt means the body contains an illegal or inconsistent frame.
	ErrCorrupt = errors.New("steim: corrupt compressed body")
	// ErrState means the decoder was reused after failure or delivery.
	ErrState = errors.New("steim: decoder already finished or failed")
)

// Sample is one decoded int32 sample together with the location of the
// difference that produced it. For X0, Diff is -1 and the location is
// frame 0, word 1.
type Sample struct {
	Value int32
	Frame int
	Word  int
	Diff  int
}

type status uint8

const (
	statusRunning status = iota
	statusFailed
	statusDelivered
)

// Decoder decodes a single big-endian Steim-1 or Steim-2 record body.
type Decoder struct {
	encoding int
	n        int
	length   int
	maxN     int

	buf      []byte
	received int
	state    status
}

// NewDecoder creates a decoder for one record. encoding must be 1 or 2,
// sampleCount N must be at least 1, bodyLength L must be a positive
// multiple of 64, and N must not exceed maxSamples.
func NewDecoder(encoding, sampleCount, bodyLength, maxSamples int) (*Decoder, error) {
	if encoding != 1 && encoding != 2 {
		return nil, ErrInvalidMetadata
	}
	if sampleCount < 1 {
		return nil, ErrInvalidMetadata
	}
	if bodyLength <= 0 || bodyLength%64 != 0 {
		return nil, ErrInvalidMetadata
	}
	if sampleCount > maxSamples {
		return nil, ErrOverflow
	}
	return &Decoder{
		encoding: encoding,
		n:        sampleCount,
		length:   bodyLength,
		maxN:     maxSamples,
		buf:      make([]byte, 0, bodyLength),
	}, nil
}

// Push accepts the next chunk of the compressed body. Chunk boundaries
// are arbitrary. Pushing more than the declared L bytes, or using a
// decoder that has already failed or delivered, fails terminally.
func (d *Decoder) Push(chunk []byte) error {
	if d.state != statusRunning {
		return ErrState
	}
	if d.received+len(chunk) > d.length {
		d.state = statusFailed
		return ErrTooLarge
	}
	d.buf = append(d.buf, chunk...)
	d.received += len(chunk)
	return nil
}

// Finish validates the complete body and, on success, delivers the N
// decoded samples exactly once. Any failure is terminal.
func (d *Decoder) Finish() ([]Sample, error) {
	if d.state != statusRunning {
		return nil, ErrState
	}
	if d.received != d.length {
		d.state = statusFailed
		return nil, ErrTruncated
	}
	samples, err := d.decode()
	if err != nil {
		d.state = statusFailed
		return nil, err
	}
	d.state = statusDelivered
	return samples, nil
}

type steimDiff struct {
	value   int32
	frame   int
	word    int
	ordinal int
}

func (d *Decoder) decode() ([]Sample, error) {
	frameCount := d.length / 64
	diffs := make([]steimDiff, 0, d.n)

	for frame := 0; frame < frameCount; frame++ {
		base := frame * 64
		words := [16]uint32{}
		for k := range words {
			words[k] = binary.BigEndian.Uint32(d.buf[base+4*k:])
		}

		control := words[0]
		for j := 0; j < 16; j++ {
			code := int((control >> (30 - 2*j)) & 0b11)
			if j == 0 && code != 0 {
				return nil, ErrCorrupt
			}
			if code == 0 {
				// No differences. Frame 0 words 1 and 2 are the
				// integration-constant slots; any other control-0 word
				// carries padding, and all such payloads are ignored.
				continue
			}
			if frame == 0 && (j == 1 || j == 2) {
				return nil, ErrCorrupt
			}
			fields, err := d.extract(words[j], code, frame, j)
			if err != nil {
				return nil, err
			}
			diffs = append(diffs, fields...)
		}
	}

	// d0 is required even when N == 1, and at least N differences must
	// exist in total.
	if len(diffs) < d.n {
		return nil, ErrCorrupt
	}

	x0 := int32(binary.BigEndian.Uint32(d.buf[4:]))
	xn := int32(binary.BigEndian.Uint32(d.buf[8:]))

	samples := make([]Sample, d.n)
	samples[0] = Sample{Value: x0, Frame: 0, Word: 1, Diff: -1}

	// diffs[0] is the bridge value d0 and is skipped. All arithmetic is
	// unsigned 32-bit so accumulation wraps modulo 2^32 exactly.
	acc := uint32(x0)
	for s := 1; s < d.n; s++ {
		delta := diffs[s]
		acc += uint32(delta.value)
		samples[s] = Sample{
			Value: int32(acc),
			Frame: delta.frame,
			Word:  delta.word,
			Diff:  delta.ordinal,
		}
	}
	if int32(acc) != xn {
		return nil, ErrCorrupt
	}
	return samples, nil
}

// extract walks one non-control-0 data word, returning its signed
// differences in high-to-low order with per-word provenance.
func (d *Decoder) extract(word uint32, code, frame, wordIndex int) ([]steimDiff, error) {
	var (
		widths         []int
		containerWidth = 32
	)

	switch d.encoding {
	case 1:
		switch code {
		case 1:
			widths = []int{8, 8, 8, 8}
		case 2:
			widths = []int{16, 16}
		case 3:
			widths = []int{32}
		default:
			return nil, ErrCorrupt
		}
	case 2:
		switch code {
		case 1:
			widths = []int{8, 8, 8, 8}
		case 2:
			dnib := word >> 30
			if dnib == 0 {
				return nil, ErrCorrupt
			}
			containerWidth = 30
			switch dnib {
			case 1:
				widths = []int{30}
			case 2:
				widths = []int{15, 15}
			case 3:
				widths = []int{10, 10, 10}
			}
		case 3:
			dnib := word >> 30
			containerWidth = 30
			switch dnib {
			case 0:
				widths = []int{6, 6, 6, 6, 6}
			case 1:
				widths = []int{5, 5, 5, 5, 5, 5}
			case 2:
				containerWidth = 28
				widths = []int{4, 4, 4, 4, 4, 4, 4}
			case 3:
				return nil, ErrCorrupt
			}
		default:
			return nil, ErrCorrupt
		}
	}

	rawValues := splitFields(word, containerWidth, widths)
	out := make([]steimDiff, len(rawValues))
	for i, raw := range rawValues {
		out[i] = steimDiff{
			value:   signExtend(raw, widths[i]),
			frame:   frame,
			word:    wordIndex,
			ordinal: i,
		}
	}
	return out, nil
}

// splitFields slices the low containerWidth bits of word into fields of
// the given widths, laid out from the high bit to the low bit. Each
// field is returned as an unsigned bit pattern; sign extension is the
// caller's job, never an arithmetic shift of the whole word.
func splitFields(word uint32, containerWidth int, widths []int) []uint32 {
	fields := make([]uint32, len(widths))
	position := containerWidth
	for i, width := range widths {
		position -= width
		if width == 32 {
			fields[i] = word
			continue
		}
		mask := uint32(1)<<width - 1
		fields[i] = (word >> position) & mask
	}
	return fields
}

// signExtend interprets raw as a width-bit two's-complement integer.
func signExtend(raw uint32, width int) int32 {
	if width == 32 {
		return int32(raw)
	}
	signBit := uint32(1) << (width - 1)
	if raw&signBit != 0 {
		return int32(raw | ^(uint32(1)<<width - 1))
	}
	return int32(raw)
}
