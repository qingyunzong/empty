package lzw

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"hash"
	"io"
)

// Decoder is an incremental LZW decoder. It exposes its full state after
// every code so callers can take checkpoints and decode ranges.
type Decoder struct {
	r        bitReader
	prev     [dictSize]int32
	ch       [dictSize]byte
	next     int
	gen      int // clear-code generation, incremented on every reset
	prevCode int
	h        hash.Hash

	// CodeIndex counts codes consumed from the stream so far.
	CodeIndex int

	lastCode  int
	lastWidth int
}

func NewDecoder(src []byte) *Decoder {
	d := &Decoder{r: bitReader{data: src}}
	d.reset()
	return d
}

func (d *Decoder) reset() {
	d.next = FirstCode
	d.prevCode = -1
	d.gen++
	d.h = sha256.New()
	var b [8]byte
	binary.LittleEndian.PutUint64(b[:], uint64(d.gen))
	d.h.Write(b[:])
}

// step consumes one code and returns its decoded output (nil for a clear
// code). It returns io.EOF when the stream is exhausted at a code
// boundary with valid zero padding.
func (d *Decoder) step() ([]byte, error) {
	// The encoder has always assigned exactly one more entry than the
	// decoder when it emits a code, so the width is derived from next+1.
	width := widthForNext(d.next + 1)
	code, ok := d.r.read(width)
	if !ok {
		rem := d.r.remaining()
		if rem >= 8 {
			return nil, ErrTrailingBits
		}
		if rem > 0 {
			if d.r.paddingValue() != 0 {
				return nil, ErrTrailingBits
			}
			d.r.pos += rem
		}
		return nil, io.EOF
	}
	d.CodeIndex++
	d.lastCode, d.lastWidth = code, width
	if code == ClearCode {
		d.reset()
		return nil, nil
	}
	if d.prevCode < 0 {
		if code >= FirstCode {
			return nil, ErrInvalidCode
		}
		d.prevCode = code
		return []byte{byte(code)}, nil
	}
	var seg []byte
	switch {
	case code < d.next:
		seg = d.expand(code)
		if err := d.addEntry(d.prevCode, seg[0]); err != nil {
			return nil, err
		}
	case code == d.next:
		// Self-reference: the code being assigned right now, meaning
		// prevString repeated with its first byte appended.
		prevSeg := d.expand(d.prevCode)
		seg = append(prevSeg, prevSeg[0])
		if err := d.addEntry(d.prevCode, prevSeg[0]); err != nil {
			return nil, err
		}
	default:
		return nil, ErrInvalidCode
	}
	d.prevCode = code
	return seg, nil
}

func (d *Decoder) addEntry(prevCode int, b byte) error {
	if d.next > MaxCode {
		return ErrDictOverflow
	}
	d.prev[d.next] = int32(prevCode)
	d.ch[d.next] = b
	var e [5]byte
	binary.LittleEndian.PutUint32(e[:4], uint32(prevCode))
	e[4] = b
	d.h.Write(e[:])
	d.next++
	return nil
}

func (d *Decoder) expand(code int) []byte {
	var rev []byte
	for code >= FirstCode {
		rev = append(rev, d.ch[code])
		code = int(d.prev[code])
	}
	rev = append(rev, byte(code))
	for i, j := 0, len(rev)-1; i < j; i, j = i+1, j-1 {
		rev[i], rev[j] = rev[j], rev[i]
	}
	return rev
}

// Checkpoint captures the complete decoder state between two codes: the
// bit cursor, the code width, the next unassigned code, the clear-code
// generation and a SHA-256 digest of the full dictionary. Because the
// digest covers the generation, a checkpoint taken before a clear code
// can never validate against the post-clear dictionary.
type Checkpoint struct {
	CodeIndex  int
	BitPos     int
	Width      int
	Next       int
	Generation int
	PrevCode   int
	Digest     [32]byte
}

// Checkpoint returns the current decoder state as a Checkpoint.
func (d *Decoder) Checkpoint() Checkpoint {
	var cp Checkpoint
	cp.CodeIndex = d.CodeIndex
	cp.BitPos = d.r.pos
	cp.Width = widthForNext(d.next + 1)
	cp.Next = d.next
	cp.Generation = d.gen
	cp.PrevCode = d.prevCode
	copy(cp.Digest[:], d.h.Sum(nil))
	return cp
}

// Trace records a full decode pass for inspection and testing.
type Trace struct {
	Codes       []int        // code values, per consumed code
	Widths      []int        // bit width used per code
	Segments    [][]byte     // decoded output per code (nil for clears)
	Checkpoints []Checkpoint // Checkpoints[i] is the state after i codes
}

// DecodeTrace decodes src, recording every code, width, output segment
// and checkpoint.
func DecodeTrace(src []byte) (*Trace, error) {
	d := NewDecoder(src)
	t := &Trace{Checkpoints: []Checkpoint{d.Checkpoint()}}
	for {
		seg, err := d.step()
		if err == io.EOF {
			return t, nil
		}
		if err != nil {
			return nil, err
		}
		t.Codes = append(t.Codes, d.lastCode)
		t.Widths = append(t.Widths, d.lastWidth)
		t.Segments = append(t.Segments, seg)
		t.Checkpoints = append(t.Checkpoints, d.Checkpoint())
	}
}

// Resume verifies cp against the prefix of src by replaying the source
// from the start, then decodes codes [cp.CodeIndex, end) and returns
// their output. A negative end decodes to the end of the stream. If the
// replayed state at cp.CodeIndex differs from cp in any field — including
// the dictionary digest and clear-code generation — it returns
// ErrCheckpointMismatch.
func Resume(src []byte, cp Checkpoint, end int) ([]byte, error) {
	if end >= 0 && end < cp.CodeIndex {
		return nil, errors.New("lzw: range end before checkpoint")
	}
	d := NewDecoder(src)
	for d.CodeIndex < cp.CodeIndex {
		if _, err := d.step(); err != nil {
			if err == io.EOF {
				return nil, ErrCheckpointMismatch
			}
			return nil, err
		}
	}
	if got := d.Checkpoint(); got != cp {
		return nil, ErrCheckpointMismatch
	}
	var out []byte
	for end < 0 || d.CodeIndex < end {
		seg, err := d.step()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		out = append(out, seg...)
	}
	return out, nil
}

// DecodeRange decodes only codes [start, end) and returns their output.
// A negative end decodes to the end of the stream.
func DecodeRange(src []byte, start, end int) ([]byte, error) {
	if start < 0 || (end >= 0 && end < start) {
		return nil, errors.New("lzw: invalid range")
	}
	d := NewDecoder(src)
	var out []byte
	for end < 0 || d.CodeIndex < end {
		seg, err := d.step()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if d.CodeIndex > start {
			out = append(out, seg...)
		}
	}
	return out, nil
}
