package textstream

import (
	"errors"
	"slices"
	"sort"
	"unicode/utf8"
)

// ErrVersionConflict is returned when an edit batch is based on a version
// that is no longer the latest committed one; the batch is not applied.
var ErrVersionConflict = errors.New("textstream: edit base is not the latest committed version")

// ErrOverlap is returned when a batch contains overlapping edits; the
// batch is not applied.
var ErrOverlap = errors.New("textstream: overlapping edits in batch")

// ErrRange is returned when an edit range falls outside the base version.
var ErrRange = errors.New("textstream: edit range out of bounds")

// Version is an immutable, committed snapshot of the document. Readers may
// safely hold a Version (and its mappings) while newer versions are
// committed.
type Version struct {
	id    int
	data  []byte
	runes []rune
	maps  []Mapping
}

// ID returns the committed version number, starting at 0.
func (v *Version) ID() int { return v.id }

// Bytes returns the raw document bytes of this version.
func (v *Version) Bytes() []byte { return slices.Clone(v.data) }

// Runes returns the decoded code points of this version.
func (v *Version) Runes() []rune { return slices.Clone(v.runes) }

// Mappings returns the byte range of every code point of this version.
func (v *Version) Mappings() []Mapping { return slices.Clone(v.maps) }

// Len returns the number of code points in this version.
func (v *Version) Len() int { return len(v.runes) }

// Edit replaces the byte range [Start, End) of the base version with Text.
// Start == End inserts, len(Text) == 0 deletes.
type Edit struct {
	Start int
	End   int
	Text  []byte
}

// Diff describes how a committed edit batch changed the decoded output.
type Diff struct {
	// NetRunes is the net change in code point count (new - old).
	NetRunes int
	// OldRunes is the affected code point index range in the base version.
	OldRunes [2]int
	// NewRunes is the affected code point index range in the new version.
	NewRunes [2]int
	// OldBytes is the affected byte range in the base version.
	OldBytes [2]int
	// NewBytes is the affected byte range in the new version.
	NewBytes [2]int
}

// Migrate maps a code point index of the base version to its index in the
// new version. It returns -1 for code points inside the affected range,
// which were removed or replaced.
func (d Diff) Migrate(oldIndex int) int {
	if oldIndex < d.OldRunes[0] {
		return oldIndex
	}
	if oldIndex >= d.OldRunes[1] {
		return oldIndex + d.NetRunes
	}
	return -1
}

// Document is a sequence of committed versions. The initial content is
// version 0.
type Document struct {
	versions []*Version
}

// NewDocument creates a Document whose version 0 decodes initial.
func NewDocument(initial []byte) *Document {
	runes, maps := DecodeAll(initial)
	return &Document{versions: []*Version{{id: 0, data: slices.Clone(initial), runes: runes, maps: maps}}}
}

// Versions returns the number of committed versions.
func (d *Document) Versions() int { return len(d.versions) }

// Latest returns the most recently committed version.
func (d *Document) Latest() *Version { return d.versions[len(d.versions)-1] }

// Version returns the committed version with the given id, or nil.
func (d *Document) Version(id int) *Version {
	if id < 0 || id >= len(d.versions) {
		return nil
	}
	return d.versions[id]
}

// ApplyEdits commits a batch of byte edits based on the version with id
// base. The batch is validated as a whole: edits refer to base-version
// byte coordinates, must not overlap, and base must be the latest
// committed version, otherwise nothing is applied. Only the minimal
// affected region is re-decoded; the returned Diff reports the net code
// point change and position migration.
func (d *Document) ApplyEdits(base int, edits ...Edit) (*Version, Diff, error) {
	old := d.Latest()
	if base != old.id {
		return nil, Diff{}, ErrVersionConflict
	}
	if len(edits) == 0 {
		return old, Diff{}, nil
	}
	es := slices.Clone(edits)
	sort.SliceStable(es, func(i, j int) bool { return es[i].Start < es[j].Start })
	for i, e := range es {
		if e.Start < 0 || e.End < e.Start || e.End > len(old.data) {
			return nil, Diff{}, ErrRange
		}
		if i > 0 && e.Start < es[i-1].End {
			return nil, Diff{}, ErrOverlap
		}
	}

	// Apply the byte edits.
	affStart, affEnd := es[0].Start, es[len(es)-1].End
	newData := make([]byte, 0, len(old.data))
	cursor := 0
	for _, e := range es {
		newData = append(newData, old.data[cursor:e.Start]...)
		newData = append(newData, e.Text...)
		cursor = e.End
	}
	newData = append(newData, old.data[cursor:]...)
	newAffEnd := len(newData) - (len(old.data) - affEnd)

	// Left edge of the re-decode region: the first old code point whose
	// decoding may have observed a byte at or after affStart. A replacement
	// character produced from a single invalid byte may have inspected up
	// to 3 following bytes, so it is unstable if it starts within 3 bytes
	// before affStart.
	i := sort.Search(len(old.maps), func(j int) bool { return old.maps[j].End > affStart })
	head := i
	for head > 0 && evidenceMax(old, head-1) >= affStart {
		head--
	}
	s0 := len(old.data)
	if head < len(old.maps) {
		s0 = old.maps[head].Start
	}

	// Re-decode the new bytes from s0 until old and new decoding
	// re-synchronize: a position that is a code point boundary in both,
	// with identical suffix bytes from there on.
	var midRunes []rune
	var midMaps []Mapping
	pos := s0
	syncOld, syncNew := -1, -1
	for syncOld < 0 {
		if pos >= newAffEnd {
			q := affEnd + (pos - newAffEnd)
			if q == len(old.data) || isBoundary(old.maps, q) {
				syncOld, syncNew = q, pos
				break
			}
		}
		r, size, incomplete := decodeOne(newData[pos:])
		if incomplete { // end of new data: flush one U+FFFD per byte
			r, size = utf8.RuneError, 1
		}
		midRunes = append(midRunes, r)
		midMaps = append(midMaps, Mapping{Start: pos, End: pos + size})
		pos += size
	}

	oldTail := len(old.maps)
	if syncOld < len(old.data) {
		oldTail = sort.Search(len(old.maps), func(j int) bool { return old.maps[j].Start >= syncOld })
	}

	delta := syncNew - syncOld
	newRunes := slices.Concat(old.runes[:head], midRunes, old.runes[oldTail:])
	newMaps := make([]Mapping, 0, head+len(midMaps)+len(old.maps)-oldTail)
	newMaps = append(newMaps, old.maps[:head]...)
	newMaps = append(newMaps, midMaps...)
	for _, m := range old.maps[oldTail:] {
		newMaps = append(newMaps, Mapping{Start: m.Start + delta, End: m.End + delta})
	}

	v := &Version{id: old.id + 1, data: newData, runes: newRunes, maps: newMaps}
	d.versions = append(d.versions, v)
	diff := Diff{
		NetRunes: len(midRunes) - (oldTail - head),
		OldRunes: [2]int{head, oldTail},
		NewRunes: [2]int{head, head + len(midRunes)},
		OldBytes: [2]int{s0, syncOld},
		NewBytes: [2]int{s0, syncNew},
	}
	return v, diff, nil
}

// evidenceMax returns the highest byte index that the decoding of old code
// point j may have inspected.
func evidenceMax(v *Version, j int) int {
	m := v.maps[j]
	if v.runes[j] == utf8.RuneError && m.End-m.Start == 1 {
		return m.Start + 3 // invalid lead byte: up to 3 more bytes examined
	}
	return m.End - 1
}

func isBoundary(maps []Mapping, pos int) bool {
	i := sort.Search(len(maps), func(j int) bool { return maps[j].Start >= pos })
	return i < len(maps) && maps[i].Start == pos
}
