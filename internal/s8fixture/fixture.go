// Package s8fixture builds physical S8 data-region byte streams independently
// of the decoder. It is a test fixture, not a general SAV writer.
package s8fixture

import (
	"encoding/binary"
	"fmt"
)

// Order selects the byte order used when a numeric literal is encoded.
type Order uint8

const (
	Little Order = iota
	Big
)

// Location records the physical position of one logical code.
type Location struct {
	GroupOffset   int64
	CodeIndex     int
	LiteralOffset int64
	LiteralLength int
}

type slot struct {
	op         byte
	literal    [8]byte
	hasLiteral bool
}

// Builder accumulates logical compressed slots. Encode arranges them into
// groups of eight opcodes followed by the literal slots for all opcode-253
// positions, in code-index order.
type Builder struct {
	order Order
	slots []slot
}

// New returns an empty builder for the given numeric literal byte order.
func New(order Order) *Builder {
	return &Builder{order: order}
}

// Add appends one opcode. A literal is required exactly when op is 253.
func (b *Builder) Add(op byte, literal []byte) error {
	s := slot{op: op}
	if op == 253 {
		if len(literal) != 8 {
			return fmt.Errorf("s8fixture: opcode 253 requires exactly 8 literal bytes, got %d", len(literal))
		}
		copy(s.literal[:], literal)
		s.hasLiteral = true
	} else if len(literal) != 0 {
		return fmt.Errorf("s8fixture: opcode %d must not have a literal", op)
	}
	b.slots = append(b.slots, s)
	return nil
}

// AddCode appends an integer opcode 1..251 whose value is code-bias.
func (b *Builder) AddCode(value, bias int) error {
	code := value + bias
	if code < 1 || code > 251 {
		return fmt.Errorf("s8fixture: value %d with bias %d gives code %d outside 1..251", value, bias, code)
	}
	return b.Add(byte(code), nil)
}

// AddLiteral appends opcode 253 with the exact eight literal bytes supplied by
// the caller.
func (b *Builder) AddLiteral(raw [8]byte) error {
	return b.Add(253, raw[:])
}

// AddNumericLiteral appends opcode 253 and encodes bits for numeric use.
func (b *Builder) AddNumericLiteral(bits uint64) error {
	var raw [8]byte
	if b.order == Big {
		binary.BigEndian.PutUint64(raw[:], bits)
	} else {
		binary.LittleEndian.PutUint64(raw[:], bits)
	}
	return b.AddLiteral(raw)
}

// AddBytesLiteral appends opcode 253 with raw bytes, for a bytes field.
func (b *Builder) AddBytesLiteral(raw [8]byte) error {
	return b.AddLiteral(raw)
}

// AddSpaces appends opcode 254.
func (b *Builder) AddSpaces() error {
	return b.Add(254, nil)
}

// AddMissing appends opcode 255.
func (b *Builder) AddMissing() error {
	return b.Add(255, nil)
}

// AddTerminator appends opcode 252. Callers building an intentionally invalid
// stream may continue adding slots afterwards.
func (b *Builder) AddTerminator() error {
	return b.Add(252, nil)
}

// Encode emits the physical stream and per-slot locations. It pads the final
// opcode header with zero bytes. It does not add a terminator if the caller
// has not added one.
func (b *Builder) Encode() ([]byte, []Location, error) {
	data := make([]byte, 0)
	locs := make([]Location, len(b.slots))

	for start := 0; start < len(b.slots); start += 8 {
		groupOffset := len(data)
		var header [8]byte
		end := start + 8
		if end > len(b.slots) {
			end = len(b.slots)
		}
		for i := start; i < end; i++ {
			header[i-start] = b.slots[i].op
		}
		data = append(data, header[:]...)

		for i := start; i < end; i++ {
			loc := Location{
				GroupOffset:   int64(groupOffset),
				CodeIndex:     i - start,
				LiteralOffset: -1,
			}
			if b.slots[i].op == 253 {
				if !b.slots[i].hasLiteral {
					return nil, nil, fmt.Errorf("s8fixture: opcode 253 at slot %d has no literal", i)
				}
				loc.LiteralOffset = int64(len(data))
				loc.LiteralLength = 8
				data = append(data, b.slots[i].literal[:]...)
			}
			locs[i] = loc
		}
	}
	return data, locs, nil
}

// EncodeBits returns one binary64 literal in the requested byte order.
func EncodeBits(bits uint64, order Order) [8]byte {
	var raw [8]byte
	if order == Big {
		binary.BigEndian.PutUint64(raw[:], bits)
	} else {
		binary.LittleEndian.PutUint64(raw[:], bits)
	}
	return raw
}

// PadBytes turns a bytes-field payload into fixed eight-byte slots. Missing
// bytes through width are filled with ASCII spaces; the last slot therefore
// carries the required padding.
func PadBytes(width int, payload []byte) ([][8]byte, error) {
	if width < 1 {
		return nil, fmt.Errorf("s8fixture: width %d must be positive", width)
	}
	if len(payload) > width {
		return nil, fmt.Errorf("s8fixture: payload length %d exceeds width %d", len(payload), width)
	}
	full := make([]byte, width)
	copy(full, payload)
	for i := len(payload); i < width; i++ {
		full[i] = ' '
	}
	slots := make([][8]byte, (width+7)/8)
	for i := range slots {
		for j := range slots[i] {
			slots[i][j] = ' '
		}
		start := i * 8
		end := start + 8
		if end > width {
			end = width
		}
		copy(slots[i][:], full[start:end])
	}
	return slots, nil
}
