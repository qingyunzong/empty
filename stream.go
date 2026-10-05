package esc

import "errors"

// StreamDecoder decodes escape sequences from a byte stream fed in
// arbitrary chunks. Chunk boundaries may fall anywhere: inside a hex
// escape, between the two halves of a surrogate pair, or inside a
// multi-byte UTF-8 rune. Incomplete trailing input is buffered until the
// rest arrives. All spans and error offsets are absolute byte positions
// in the whole stream.
type StreamDecoder struct {
	buf   []byte // undecoded tail (an incomplete escape or UTF-8 prefix)
	base  int    // absolute offset of buf[0] in the stream
	text  []byte
	spans []Span
	done  bool
}

// Write feeds the next chunk. Everything decodable is consumed
// immediately; an incomplete trailing escape (including a high surrogate
// still waiting for its pair) or UTF-8 prefix is retained for the next
// call. On error the decoder is left in a failed state and must not be
// used further.
func (d *StreamDecoder) Write(p []byte) error {
	if d.done {
		return errors.New("esc: write on failed or closed StreamDecoder")
	}
	d.buf = append(d.buf, p...)
	n, err := decode(d.buf, d.base, &d.text, &d.spans, false)
	if err != nil {
		d.done = true
		return err
	}
	d.buf = d.buf[n:]
	d.base += n
	return nil
}

// Close flushes the decoder and returns the accumulated result. Any
// buffered incomplete escape or UTF-8 prefix is reported as a truncation
// error spanning the exact unterminated region.
func (d *StreamDecoder) Close() (*Result, error) {
	if d.done {
		return nil, errors.New("esc: StreamDecoder already failed or closed")
	}
	d.done = true
	if _, err := decode(d.buf, d.base, &d.text, &d.spans, true); err != nil {
		return nil, err
	}
	return &Result{Text: string(d.text), Spans: d.spans}, nil
}
