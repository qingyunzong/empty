// Package utf8fix rewrites a byte stream into valid UTF-8: every invalid
// byte is replaced by exactly one U+FFFD replacement character while valid
// sequences are passed through unchanged. It also records a bidirectional
// position mapping between original byte offsets and fixed rune indexes.
//
// The Fixer is streaming: a trailing byte sequence that is still a valid
// prefix of some rune is held back and never judged until more input
// arrives or Flush is called, so results are independent of chunking.
package utf8fix

import "unicode/utf8"

// Mapping is the bidirectional position mapping between the original byte
// stream and the fixed rune stream.
type Mapping struct {
	// ByteToRune[i] is the output rune index that original byte i maps to.
	// Continuation bytes of a valid multi-byte sequence share the rune
	// index of their lead byte.
	ByteToRune []int `json:"byteToRune"`
	// RuneToByte[j] is the original byte offset at which the source of
	// output rune j starts. For a replacement character it is the offset
	// of the single invalid byte it replaces.
	RuneToByte []int `json:"runeToByte"`
}

// Fixer incrementally fixes a UTF-8 byte stream.
type Fixer struct {
	pending []byte // held incomplete trailing sequence, not yet judged
	byteOff int    // original offset of pending[0]
	runeIdx int    // next output rune index
	out     []byte // fixed output produced since last Drain
	mapping Mapping
}

// NewFixer returns a ready-to-use Fixer.
func NewFixer() *Fixer { return &Fixer{} }

// Mapping returns the mapping accumulated so far.
func (f *Fixer) Mapping() Mapping { return f.mapping }

// Drain returns the fixed output produced so far and clears the buffer.
func (f *Fixer) Drain() []byte {
	b := f.out
	f.out = nil
	return b
}

// Write consumes one chunk of the original stream. A trailing incomplete
// rune prefix is buffered instead of being judged prematurely.
func (f *Fixer) Write(p []byte) {
	data := append(f.pending, p...)
	base := f.byteOff
	i := 0
	for i < len(data) {
		if !utf8.FullRune(data[i:]) {
			break // incomplete tail: hold until more data or Flush
		}
		r, size := utf8.DecodeRune(data[i:])
		if r == utf8.RuneError && size == 1 {
			f.emit(base+i, 1)
			f.out = append(f.out, 0xEF, 0xBF, 0xBD) // U+FFFD
			i++
			continue
		}
		f.emit(base+i, size)
		f.out = append(f.out, data[i:i+size]...)
		i += size
	}
	f.pending = append([]byte(nil), data[i:]...)
	f.byteOff = base + i
}

// Flush terminates the stream. Every byte left in an unterminated trailing
// sequence is invalid and replaced by one U+FFFD each, matching one-shot
// decoding of the whole input.
func (f *Fixer) Flush() {
	for k := range f.pending {
		f.emit(f.byteOff+k, 1)
		f.out = append(f.out, 0xEF, 0xBF, 0xBD)
	}
	f.pending = nil
}

// emit records the mapping for one output rune sourced from size original
// bytes starting at start.
func (f *Fixer) emit(start, size int) {
	f.mapping.RuneToByte = append(f.mapping.RuneToByte, start)
	for k := 0; k < size; k++ {
		f.mapping.ByteToRune = append(f.mapping.ByteToRune, f.runeIdx)
	}
	f.runeIdx++
}

// Fix processes src in one shot and returns the fixed bytes and mapping.
func Fix(src []byte) ([]byte, Mapping) {
	f := NewFixer()
	f.Write(src)
	f.Flush()
	return f.Drain(), f.Mapping()
}
