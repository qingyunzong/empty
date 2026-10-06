// Package utf8fix repairs invalid UTF-8 byte streams: every invalid byte is
// replaced by exactly one U+FFFD replacement character, while valid sequences
// are preserved byte-for-byte. It also produces a bidirectional position
// mapping between original byte offsets and fixed code-point indices.
//
// The Fixer is streaming-safe: a trailing partial sequence at a chunk
// boundary is never judged prematurely; it is held until more data arrives
// or Close is called.
package utf8fix

import "unicode/utf8"

// Replacement is the replacement character substituted for each invalid byte.
const Replacement = "\uFFFD"

// Mapping is the bidirectional position map between the original byte stream
// and the fixed code-point stream.
type Mapping struct {
	// CPToByte[i] is the original byte offset at which fixed code point i starts.
	CPToByte []int `json:"cpToByte"`
	// ByteToCP[j] is the fixed code-point index that original byte j belongs to.
	// All bytes of one valid multi-byte sequence share the same code point;
	// each invalid byte owns the code point of its replacement character.
	ByteToCP []int `json:"byteToCP"`
}

// Fixer incrementally repairs a UTF-8 byte stream.
type Fixer struct {
	pend     []byte // unconsumed bytes (a possible valid-sequence prefix)
	pendBase int    // original byte offset of pend[0]
	out      []byte
	cpToByte []int
	byteToCP []int
	closed   bool
}

// New returns a ready-to-use Fixer.
func New() *Fixer { return &Fixer{} }

// Write consumes the next chunk of the original stream. A trailing partial
// sequence is buffered, not judged, until more data or Close arrives.
func (f *Fixer) Write(p []byte) {
	if f.closed {
		panic("utf8fix: Write after Close")
	}
	f.pend = append(f.pend, p...)
	f.drain(false)
}

// Close flushes the stream: every byte still pending is an invalid byte
// (a truncated sequence at EOF) and becomes one replacement character.
func (f *Fixer) Close() {
	if f.closed {
		return
	}
	f.closed = true
	f.drain(true)
}

// Bytes returns the repaired output accumulated so far.
func (f *Fixer) Bytes() []byte { return f.out }

// Mapping returns the bidirectional byte<->code-point position map.
func (f *Fixer) Mapping() Mapping {
	return Mapping{CPToByte: f.cpToByte, ByteToCP: f.byteToCP}
}

// drain emits everything decidable. In non-final mode it stops before a
// pending prefix that could still grow into a valid sequence.
func (f *Fixer) drain(final bool) {
	for len(f.pend) > 0 {
		r, size := utf8.DecodeRune(f.pend)
		if r == utf8.RuneError && size == 1 {
			if !final && !utf8.FullRune(f.pend) {
				return // incomplete sequence: wait for more bytes
			}
			f.emit([]byte(Replacement), 1) // one invalid byte -> one U+FFFD
			continue
		}
		f.emit(f.pend[:size], size) // valid sequence: keep original bytes
	}
}

// emit appends one output code point (out bytes b) consuming n original bytes.
func (f *Fixer) emit(b []byte, n int) {
	cp := len(f.cpToByte)
	f.cpToByte = append(f.cpToByte, f.pendBase)
	f.out = append(f.out, b...)
	for i := 0; i < n; i++ {
		f.byteToCP = append(f.byteToCP, cp)
	}
	f.pend = f.pend[n:]
	f.pendBase += n
}

// Fix repairs src in one shot and returns the fixed bytes plus the mapping.
func Fix(src []byte) ([]byte, Mapping) {
	f := New()
	f.Write(src)
	f.Close()
	return f.Bytes(), f.Mapping()
}
