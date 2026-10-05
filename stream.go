package stresc

import "unicode/utf8"

// Decoder is a streaming escape decoder. Source bytes may be fed in
// arbitrary chunks; escape sequences and surrogate pairs split across
// chunk boundaries are handled transparently. The final chunk must be
// fed with final == true so that truncated escapes are reported.
type Decoder struct {
	buf   []byte // undecoded source bytes
	off   int    // absolute source offset of buf[0]
	out   []rune // decoded runes
	spans []Span // source span per decoded rune
	err   *Error
	final bool
}

// Feed appends a chunk of source and decodes as much as possible.
// It returns a non-nil *Error on the first decode failure; afterwards
// the Decoder is unusable.
func (d *Decoder) Feed(chunk string, final bool) *Error {
	if d.err != nil {
		return d.err
	}
	if d.final {
		d.err = &Error{Msg: "feed after final chunk", Span: Span{d.off, d.off}}
		return d.err
	}
	d.buf = append(d.buf, chunk...)
	d.final = final
	d.pump()
	return d.err
}

// String returns the text decoded so far.
func (d *Decoder) String() string { return string(d.out) }

// Spans returns the source span of every rune decoded so far.
func (d *Decoder) Spans() []Span { return append([]Span(nil), d.spans...) }

func (d *Decoder) emit(r rune, sp Span) {
	d.out = append(d.out, r)
	d.spans = append(d.spans, sp)
}

func (d *Decoder) pump() {
	for len(d.buf) > 0 {
		if d.buf[0] == '\\' {
			n, r, incomplete, err := scanEscape(string(d.buf))
			if incomplete {
				if d.final {
					d.err = &Error{Msg: "truncated escape", Span: Span{d.off, d.off + len(d.buf)}}
				}
				return
			}
			if err != nil {
				err.Span.Start += d.off
				err.Span.End += d.off
				d.err = err
				return
			}
			d.emit(r, Span{d.off, d.off + n})
			d.buf = d.buf[n:]
			d.off += n
			continue
		}
		if !utf8.FullRune(d.buf) {
			if d.final {
				d.err = &Error{Msg: "truncated utf-8", Span: Span{d.off, d.off + len(d.buf)}}
			}
			return
		}
		r, size := utf8.DecodeRune(d.buf)
		if r == utf8.RuneError && size == 1 {
			d.err = &Error{Msg: "invalid utf-8", Span: Span{d.off, d.off + 1}}
			return
		}
		d.emit(r, Span{d.off, d.off + size})
		d.buf = d.buf[size:]
		d.off += size
	}
}
