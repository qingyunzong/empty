package dataeng

import (
	"bytes"
	"errors"
	"fmt"
	"io"
)

// BadRecord is a record that failed schema selection or field validation.
// It is isolated from the good stream together with its absolute byte offset
// and raw bytes, so it can be replayed or inspected without re-reading the
// source.
type BadRecord struct {
	Offset int64 // absolute byte offset of the record in the stream
	Raw    []byte
	Errs   []error
}

func (b *BadRecord) Error() string {
	return fmt.Sprintf("bad record at offset %d: %v", b.Offset, errors.Join(b.Errs...))
}

// Item is one framed record: exactly one of Record or Bad is non-nil.
type Item struct {
	Record *Record
	Bad    *BadRecord
}

// Reader frames a byte stream into fixed-width records and decodes them.
// Framing is strictly byte-count based: the reader never counts runes or
// UTF-8 characters, so records containing multi-byte decodings are split at
// the same boundaries regardless of content. Blocks may be read in any size;
// a record spanning block boundaries is reassembled before decoding.
type Reader struct {
	r           io.Reader
	reg         *Registry
	cp          CodePage
	frameLen    int
	buf         []byte // pending bytes, buf[0] is at stream offset base
	base        int64  // absolute stream offset of buf[0]
	eof         bool
	block       []byte
	trailingBad bool // trailing partial record already reported
}

// NewReader builds a reader that frames src into records of frameLen bytes
// and selects schemas from reg using code page cp. frameLen must match the
// record length of the schemas registered for the stream.
func NewReader(src io.Reader, reg *Registry, cp CodePage, frameLen int) (*Reader, error) {
	if frameLen <= 0 {
		return nil, fmt.Errorf("dataeng: frame length must be positive")
	}
	if _, err := cp.table(); err != nil {
		return nil, err
	}
	return &Reader{
		r:        src,
		reg:      reg,
		cp:       cp,
		frameLen: frameLen,
		block:    make([]byte, 32*1024),
	}, nil
}

// Next returns the next framed record, or io.EOF when the stream is
// exhausted. A trailing partial record at end of stream is reported once as
// a BadRecord before io.EOF.
func (r *Reader) Next() (Item, error) {
	for len(r.buf) < r.frameLen {
		if r.eof {
			if len(r.buf) == 0 || r.trailingBad {
				return Item{}, io.EOF
			}
			r.trailingBad = true
			bad := &BadRecord{
				Offset: r.base,
				Raw:    bytes.Clone(r.buf),
				Errs:   []error{fmt.Errorf("truncated record: got %d bytes, want %d", len(r.buf), r.frameLen)},
			}
			r.buf = nil
			return Item{Bad: bad}, nil
		}
		n, err := r.r.Read(r.block)
		r.buf = append(r.buf, r.block[:n]...)
		if err != nil {
			if errors.Is(err, io.EOF) {
				r.eof = true
				continue
			}
			return Item{}, err
		}
		if n == 0 {
			return Item{}, fmt.Errorf("dataeng: reader made no progress")
		}
	}

	raw := r.buf[:r.frameLen]
	offset := r.base
	r.buf = r.buf[r.frameLen:]
	r.base += int64(r.frameLen)

	schema, err := r.reg.Match(raw, r.cp)
	if err != nil {
		return Item{Bad: &BadRecord{Offset: offset, Raw: bytes.Clone(raw), Errs: []error{err}}}, nil
	}
	rec, fieldErrs := Decode(schema, raw, offset)
	if len(fieldErrs) > 0 {
		errs := make([]error, len(fieldErrs))
		for i, fe := range fieldErrs {
			errs[i] = fe
		}
		return Item{Bad: &BadRecord{Offset: offset, Raw: bytes.Clone(raw), Errs: errs}}, nil
	}
	return Item{Record: rec}, nil
}

// ReadAll drains the reader, returning good records and isolated bad records
// separately. Bad records never interrupt the good stream.
func (r *Reader) ReadAll() (good []*Record, bad []*BadRecord, err error) {
	for {
		item, err := r.Next()
		if errors.Is(err, io.EOF) {
			return good, bad, nil
		}
		if err != nil {
			return good, bad, err
		}
		if item.Bad != nil {
			bad = append(bad, item.Bad)
			continue
		}
		good = append(good, item.Record)
	}
}
