package recstream

import "io"

// CodePoint is one decoded code point together with the absolute byte range
// it occupied in the input stream: [Start, End).
type CodePoint struct {
	Rune  rune
	Start int64
	End   int64
}

// Record is one decoded record. Start and End delimit the record content in
// the input stream, excluding any encoding declaration and the record
// terminator. Points holds every code point with its original byte range.
type Record struct {
	Encoding Encoding
	Points   []CodePoint
	Start    int64
	End      int64
}

// Text returns the decoded record content.
func (r Record) Text() string {
	rs := make([]rune, len(r.Points))
	for i, p := range r.Points {
		rs[i] = p.Rune
	}
	return string(rs)
}

// Collect drains d and groups events into records. All input must have been
// written and Close called beforehand; otherwise Collect may return
// ErrNeedMore. A final record without a terminator is still returned.
func Collect(d *Decoder) ([]Record, error) {
	var records []Record
	var cur *Record
	for {
		ev, err := d.Next()
		if err == io.EOF {
			if cur != nil {
				records = append(records, *cur)
			}
			return records, nil
		}
		if err != nil {
			return records, err
		}
		switch ev.Kind {
		case EventDeclaration:
			if cur == nil {
				cur = &Record{}
			}
			cur.Encoding = ev.Encoding
			cur.Start = ev.End
			cur.End = ev.End
		case EventRune:
			if cur == nil {
				cur = &Record{Encoding: ev.Encoding, Start: ev.Start}
			}
			cur.Points = append(cur.Points, CodePoint{Rune: ev.Rune, Start: ev.Start, End: ev.End})
			cur.End = ev.End
		case EventRecordEnd:
			if cur == nil {
				cur = &Record{Encoding: ev.Encoding, Start: ev.Start, End: ev.Start}
			}
			records = append(records, *cur)
			cur = nil
		}
	}
}

// ReadAll decodes the entire stream from r and returns its records.
func ReadAll(r io.Reader, initial ...Encoding) ([]Record, error) {
	d := NewDecoder(initial...)
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			d.Write(buf[:n])
		}
		if err == io.EOF {
			d.Close()
			break
		}
		if err != nil {
			return nil, err
		}
	}
	return Collect(d)
}
