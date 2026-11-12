package dataeng

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"
)

// Instruction opcodes used by the canonical and wire encodings.
const (
	opAdd  byte = 1
	opRun  byte = 2
	opCopy byte = 3
)

// hashWindow returns the canonical instruction digest for a window
// declaration. The digest covers every field that defines the produced
// target: ID, interval, T, instructions and expected target digest.
func hashWindow(w Window) [32]byte {
	h := sha256.New()
	var u [binary.MaxVarintLen64]byte
	put := func(v int64) {
		n := binary.PutVarint(u[:], v)
		_, _ = h.Write(u[:n])
	}
	putBytes := func(p []byte) {
		put(int64(len(p)))
		_, _ = h.Write(p)
	}

	putBytes([]byte(w.ID))
	put(w.BaseOffset)
	put(w.Span)
	put(w.TargetLength)
	put(int64(len(w.Instructions)))
	for _, ins := range w.Instructions {
		switch op := ins.(type) {
		case Add:
			_, _ = h.Write([]byte{opAdd})
			putBytes(op.Bytes)
		case Run:
			_, _ = h.Write([]byte{opRun})
			_, _ = h.Write([]byte{op.Byte})
			put(op.Count)
		case Copy:
			_, _ = h.Write([]byte{opCopy})
			_, _ = h.Write([]byte{byte(op.Mode)})
			put(op.Length)
			put(op.Operand)
			put(op.OperandSlot)
		default:
			panic(fmt.Sprintf("dataeng: cannot hash instruction %T", ins))
		}
	}
	_, _ = h.Write(w.TargetSHA256[:])

	var digest [32]byte
	copy(digest[:], h.Sum(nil))
	return digest
}

// EncodeWindow serializes one window declaration into a self-describing byte
// slice. The format is length-prefixed varints so callers can persist or
// transport windows without an external schema.
func EncodeWindow(w Window) ([]byte, error) {
	if _, err := validateInstructions(&w); err != nil {
		return nil, err
	}
	out := make([]byte, 0, 64)
	out = appendString(out, w.ID)
	out = binary.AppendVarint(out, w.BaseOffset)
	out = binary.AppendVarint(out, w.Span)
	out = binary.AppendVarint(out, w.TargetLength)
	out = append(out, w.TargetSHA256[:]...)
	out = binary.AppendVarint(out, int64(len(w.Instructions)))
	for _, ins := range w.Instructions {
		switch op := ins.(type) {
		case Add:
			out = append(out, opAdd)
			out = binary.AppendVarint(out, int64(len(op.Bytes)))
			out = append(out, op.Bytes...)
		case Run:
			out = append(out, opRun, op.Byte)
			out = binary.AppendVarint(out, op.Count)
		case Copy:
			out = append(out, opCopy, byte(op.Mode))
			out = binary.AppendVarint(out, op.Length)
			out = binary.AppendVarint(out, op.Operand)
			out = binary.AppendVarint(out, op.OperandSlot)
		default:
			return nil, fmt.Errorf("%w: %T", ErrUnknownInstruction, ins)
		}
	}
	return out, nil
}

// DecodeWindow parses a slice produced by EncodeWindow.
func DecodeWindow(p []byte) (Window, error) {
	r := &sliceReader{buf: p}
	id, err := r.readString()
	if err != nil {
		return Window{}, err
	}
	w := Window{ID: id}
	if w.BaseOffset, err = r.readVarint(); err != nil {
		return Window{}, err
	}
	if w.Span, err = r.readVarint(); err != nil {
		return Window{}, err
	}
	if w.TargetLength, err = r.readVarint(); err != nil {
		return Window{}, err
	}
	if n, err := io.ReadFull(r, w.TargetSHA256[:]); err != nil || n != 32 {
		return Window{}, fmt.Errorf("dataeng: decoding target digest: %w", err)
	}
	count, err := r.readVarint()
	if err != nil {
		return Window{}, err
	}
	if count < 0 || count > int64(len(r.buf)) {
		return Window{}, fmt.Errorf("%w: instruction count %d", ErrOverflow, count)
	}
	w.Instructions = make([]Instruction, 0, count)
	for i := int64(0); i < count; i++ {
		tag, err := r.readByte()
		if err != nil {
			return Window{}, err
		}
		switch tag {
		case opAdd:
			n, err := r.readVarint()
			if err != nil {
				return Window{}, err
			}
			if n < 0 {
				return Window{}, fmt.Errorf("%w: ADD length %d", ErrOverflow, n)
			}
			blob, err := r.readBytes(int(n))
			if err != nil {
				return Window{}, err
			}
			w.Instructions = append(w.Instructions, Add{Bytes: blob})
		case opRun:
			b, err := r.readByte()
			if err != nil {
				return Window{}, err
			}
			n, err := r.readVarint()
			if err != nil {
				return Window{}, err
			}
			w.Instructions = append(w.Instructions, Run{Byte: b, Count: n})
		case opCopy:
			mode, err := r.readByte()
			if err != nil {
				return Window{}, err
			}
			length, err := r.readVarint()
			if err != nil {
				return Window{}, err
			}
			operand, err := r.readVarint()
			if err != nil {
				return Window{}, err
			}
			slot, err := r.readVarint()
			if err != nil {
				return Window{}, err
			}
			w.Instructions = append(w.Instructions, Copy{
				Mode: CopyMode(mode), Length: length, Operand: operand, OperandSlot: slot,
			})
		default:
			return Window{}, fmt.Errorf("%w: opcode %d", ErrBadMode, tag)
		}
	}
	if r.pos != len(r.buf) {
		return Window{}, fmt.Errorf("dataeng: %d trailing bytes after window", len(r.buf)-r.pos)
	}
	return w, nil
}

func appendString(out []byte, s string) []byte {
	out = binary.AppendVarint(out, int64(len(s)))
	return append(out, s...)
}

type sliceReader struct {
	buf []byte
	pos int
}

func (r *sliceReader) Read(p []byte) (int, error) {
	if r.pos >= len(r.buf) {
		return 0, io.EOF
	}
	n := copy(p, r.buf[r.pos:])
	r.pos += n
	return n, nil
}

func (r *sliceReader) readByte() (byte, error) {
	if r.pos >= len(r.buf) {
		return 0, io.ErrUnexpectedEOF
	}
	b := r.buf[r.pos]
	r.pos++
	return b, nil
}

func (r *sliceReader) readVarint() (int64, error) {
	v, n := binary.Varint(r.buf[r.pos:])
	if n <= 0 {
		return 0, fmt.Errorf("dataeng: malformed varint at %d", r.pos)
	}
	r.pos += n
	return v, nil
}

func (r *sliceReader) readString() (string, error) {
	n, err := r.readVarint()
	if err != nil {
		return "", err
	}
	blob, err := r.readBytes(int(n))
	if err != nil {
		return "", err
	}
	return string(blob), nil
}

func (r *sliceReader) readBytes(n int) ([]byte, error) {
	if n < 0 || r.pos+n > len(r.buf) || r.pos+n < r.pos {
		return nil, fmt.Errorf("%w: want %d bytes at %d", ErrOverflow, n, r.pos)
	}
	blob := make([]byte, n)
	copy(blob, r.buf[r.pos:r.pos+n])
	r.pos += n
	return blob, nil
}
