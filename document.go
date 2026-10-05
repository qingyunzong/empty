package streamtext

import (
	"errors"
	"sort"
)

var (
	// ErrVersionConflict is returned when the expected version does not
	// match the document version; the edit batch is not applied.
	ErrVersionConflict = errors.New("streamtext: version conflict")
	// ErrOverlap is returned when edits in a batch overlap.
	ErrOverlap = errors.New("streamtext: overlapping edits")
	// ErrRange is returned when an edit range is out of bounds.
	ErrRange = errors.New("streamtext: edit range out of bounds")
)

// Edit replaces the byte range [Start, End) of the committed version with
// Text. Start == End inserts, Text == nil deletes.
type Edit struct {
	Start int
	End   int
	Text  []byte
}

// Document is an immutable, versioned byte string plus its decoded code
// points and their byte spans. Apply returns a new Document; previously
// returned Documents (and their mappings) stay valid for readers.
type Document struct {
	version uint64
	data    []byte
	runes   []rune
	spans   []Span
}

// NewDocument decodes data and returns the initial version (0).
func NewDocument(data []byte) *Document {
	runes, spans := Decode(data)
	return &Document{data: data, runes: runes, spans: spans}
}

// Version returns the committed version number.
func (d *Document) Version() uint64 { return d.version }

// Data returns the raw bytes. Callers must not mutate the result.
func (d *Document) Data() []byte { return d.data }

// Runes returns the decoded code points. Callers must not mutate the result.
func (d *Document) Runes() []rune { return d.runes }

// Spans returns the source byte range of each code point, parallel to
// Runes. Callers must not mutate the result.
func (d *Document) Spans() []Span { return d.spans }

// Delta describes the net effect of an applied edit batch.
type Delta struct {
	Version   uint64 // new document version
	ByteStart int    // start of the affected region, old byte coordinates
	ByteEnd   int    // end of the affected region, old byte coordinates
	NewStart  int    // start of the affected region, new byte coordinates
	NewEnd    int    // end of the affected region, new byte coordinates
	Removed   []rune // old code points in the affected region
	Inserted  []rune // new code points in the affected region
	NetRunes  int    // len(Inserted) - len(Removed)
	Shift     int    // byte offset migration for positions >= ByteEnd
}

// Apply applies a batch of edits against the committed version and returns
// the new Document plus a Delta. The batch takes effect only if version
// equals d.Version() and no edits overlap; otherwise nothing changes.
// The receiver is not modified, so readers may keep old mappings.
func (d *Document) Apply(version uint64, edits []Edit) (*Document, *Delta, error) {
	if version != d.version {
		return nil, nil, ErrVersionConflict
	}
	es := make([]Edit, len(edits))
	copy(es, edits)
	sort.SliceStable(es, func(i, j int) bool { return es[i].Start < es[j].Start })
	prevEnd := 0
	for i, e := range es {
		if e.Start < 0 || e.End < e.Start || e.End > len(d.data) {
			return nil, nil, ErrRange
		}
		if i > 0 && e.Start < prevEnd {
			return nil, nil, ErrOverlap
		}
		prevEnd = e.End
	}
	if len(es) == 0 {
		nd := &Document{version: d.version + 1, data: d.data, runes: d.runes, spans: d.spans}
		return nd, &Delta{Version: nd.version}, nil
	}

	nb := make([]byte, 0, len(d.data))
	pos := 0
	for _, e := range es {
		nb = append(nb, d.data[pos:e.Start]...)
		nb = append(nb, e.Text...)
		pos = e.End
	}
	nb = append(nb, d.data[pos:]...)

	ns := es[0].Start              // first edited byte, old == new coords
	oe := es[len(es)-1].End        // end of last edit, old coords
	shift := len(nb) - len(d.data) // byte migration for positions >= oe

	// Left boundary: old span boundaries at or before ns remain boundaries
	// in the new data, because the prefix bytes are unchanged. Back up to
	// the start of the old span containing ns.
	left := ns
	li := sort.Search(len(d.spans), func(i int) bool { return d.spans[i].End > ns })
	if li < len(d.spans) && d.spans[li].Start < ns {
		left = d.spans[li].Start
	}

	// Additionally, the byte now sitting at ns may continue a sequence
	// whose lead byte lies in the unchanged prefix and was previously
	// truncated (decoded as replacements). If so, the rune crosses the
	// edit edge and the lead byte must be re-decoded too.
	if ns < len(nb) {
		c := 0
		for c < 3 && ns-1-c >= 0 && nb[ns-1-c] >= 0x80 && nb[ns-1-c] <= 0xBF {
			c++
		}
		if p := ns - 1 - c; p >= 0 && p < left {
			if n := seqLen(nb[p]); n > c+1 && contOK(nb[p], nb[ns], c+1) {
				ok := true
				for j := 1; j <= c; j++ {
					if !contOK(nb[p], nb[p+j], j) {
						ok = false
						break
					}
				}
				if ok {
					left = p
				}
			}
		}
	}
	li = sort.Search(len(d.spans), func(i int) bool { return d.spans[i].End > left })

	// Right boundary (old coords): extend to the end of the old span
	// containing oe, since the edit may have broken that sequence.
	rightOld := oe
	ri := sort.Search(len(d.spans), func(i int) bool { return d.spans[i].Start >= oe })
	if ri > 0 && d.spans[ri-1].End > oe {
		rightOld = d.spans[ri-1].End
	}

	// Re-decode only the affected window. If the window ends with an
	// incomplete sequence, extend across the edit edge into the unchanged
	// continuation bytes that follow (at most 3) so cross-edge sequences
	// are repaired.
	rNew := rightOld + shift
	dec := NewDecoderAt(left)
	ins, insSpans := dec.Write(nb[left:rNew])
	k := 0
	for dec.Pending() && rNew+k < len(nb) && k < 3 &&
		nb[rNew+k] >= 0x80 && nb[rNew+k] <= 0xBF {
		r2, s2 := dec.Write(nb[rNew+k : rNew+k+1])
		ins = append(ins, r2...)
		insSpans = append(insSpans, s2...)
		k++
	}
	r3, s3 := dec.Flush()
	ins = append(ins, r3...)
	insSpans = append(insSpans, s3...)
	rightOld += k
	rNew += k

	ri2 := sort.Search(len(d.spans), func(i int) bool { return d.spans[i].Start >= rightOld })

	removed := make([]rune, ri2-li)
	copy(removed, d.runes[li:ri2])

	newRunes := make([]rune, 0, li+len(ins)+len(d.runes)-ri2)
	newRunes = append(newRunes, d.runes[:li]...)
	newRunes = append(newRunes, ins...)
	newRunes = append(newRunes, d.runes[ri2:]...)

	newSpans := make([]Span, 0, li+len(insSpans)+len(d.spans)-ri2)
	newSpans = append(newSpans, d.spans[:li]...)
	newSpans = append(newSpans, insSpans...)
	for _, s := range d.spans[ri2:] {
		newSpans = append(newSpans, Span{Start: s.Start + shift, End: s.End + shift})
	}

	nd := &Document{
		version: d.version + 1,
		data:    nb,
		runes:   newRunes,
		spans:   newSpans,
	}
	delta := &Delta{
		Version:   nd.version,
		ByteStart: left,
		ByteEnd:   rightOld,
		NewStart:  left,
		NewEnd:    rNew,
		Removed:   removed,
		Inserted:  ins,
		NetRunes:  len(ins) - len(removed),
		Shift:     shift,
	}
	return nd, delta, nil
}
