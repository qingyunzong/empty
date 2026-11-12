package tiff

import (
	"bytes"
	"encoding/binary"
	"sort"
	"testing"
)

type fixtureImage struct {
	width, height int
	bands         int
	planar        int
	rowsPerStrip  int
	compression   int
	pixels        []byte

	cycleBack    int
	cycleSet     bool
	dupTag       bool
	crossLine    bool
	truncateAt   int
	badNextOff   uint32
	unknownTag   bool
	unknownCount uint32
}

type fixture struct {
	order  binary.ByteOrder
	little bool
	images []*fixtureImage
}

type tagValue struct {
	tag    uint16
	typ    uint16
	count  uint32
	values []uint32
	raw    []byte
}

func newFixture(little bool, images ...*fixtureImage) *fixture {
	f := &fixture{little: little, images: images}
	if little {
		f.order = binary.LittleEndian
	} else {
		f.order = binary.BigEndian
	}
	return f
}

func (f *fixture) put16(b *bytes.Buffer, v uint16) {
	var buf [2]byte
	f.order.PutUint16(buf[:], v)
	b.Write(buf[:])
}

func (f *fixture) put32(b *bytes.Buffer, v uint32) {
	var buf [4]byte
	f.order.PutUint32(buf[:], v)
	b.Write(buf[:])
}

func valueByteSize(e tagValue) int {
	switch e.typ {
	case typeByte:
		return int(e.count)
	case typeShort:
		return int(e.count) * 2
	case typeLong:
		return int(e.count) * 4
	}
	return 0
}

func (f *fixture) encodeValues(b *bytes.Buffer, e tagValue) {
	switch e.typ {
	case typeShort:
		for _, v := range e.values {
			f.put16(b, uint16(v))
		}
	case typeLong:
		for _, v := range e.values {
			f.put32(b, v)
		}
	case typeByte:
		b.Write(e.raw)
	}
}

func sortEntries(entries []tagValue) {
	sort.Slice(entries, func(i, j int) bool { return entries[i].tag < entries[j].tag })
}

func encodeExternalPayload(f *fixture, entries []tagValue) []byte {
	var ext bytes.Buffer
	for _, e := range entries {
		if valueByteSize(e) <= 4 {
			continue
		}
		f.encodeValues(&ext, e)
	}
	return ext.Bytes()
}

type ifdPlan struct {
	entries  []tagValue
	external []byte
	strips   []rawStrip
	img      *fixtureImage
}

func (f *fixture) entriesFor(img *fixtureImage) []tagValue {
	entries := []tagValue{
		{tag: tagImageWidth, typ: typeShort, count: 1, values: []uint32{uint32(img.width)}},
		{tag: tagImageLength, typ: typeShort, count: 1, values: []uint32{uint32(img.height)}},
		{tag: tagSamplesPerPixel, typ: typeShort, count: 1, values: []uint32{uint32(img.bands)}},
		{tag: tagPlanarConfig, typ: typeShort, count: 1, values: []uint32{uint32(img.planar)}},
		{tag: tagRowsPerStrip, typ: typeShort, count: 1, values: []uint32{uint32(img.rowsPerStrip)}},
	}
	if img.compression != 1 {
		entries = append(entries, tagValue{tag: tagCompression, typ: typeShort, count: 1, values: []uint32{uint32(img.compression)}})
	}
	bits := make([]uint32, img.bands)
	for i := range bits {
		bits[i] = 8
	}
	entries = append(entries, tagValue{tag: tagBitsPerSample, typ: typeShort, count: uint32(img.bands), values: bits})
	if img.unknownTag {
		n := img.unknownCount
		if n == 0 {
			n = 6
		}
		raw := make([]byte, n)
		for i := range raw {
			raw[i] = byte(i + 1)
		}
		entries = append(entries, tagValue{tag: 700, typ: typeByte, count: n, raw: raw})
	}
	return entries
}

func (f *fixture) layoutOffsets(plans []ifdPlan) []int {
	offsets := make([]int, len(plans))
	cursor := 8
	for i := range plans {
		plans[i].external = encodeExternalPayload(f, plans[i].entries)
		offsets[i] = cursor
		cursor += 2 + len(plans[i].entries)*12 + 4 + len(plans[i].external)
	}
	return offsets
}

// appendStripArrays adds LONG arrays for strip offsets and byte counts. The
// strip area starts after all IFD blocks and their external payloads; the
// exact start is derived from the post-array payload sizes so offsets never
// rely on estimates.
func (f *fixture) appendStripArrays(plans []ifdPlan) int {
	// First compute where the strip area begins, given that two LONG arrays
	// will be present in each plan.
	blockEnd := 8
	for i := range plans {
		n := len(plans[i].entries) + 2
		ext := 0
		for _, e := range plans[i].entries {
			if valueByteSize(e) > 4 {
				ext += valueByteSize(e)
			}
		}
		for k := 0; k < 2; k++ {
			if size := len(plans[i].strips) * 4; size > 4 {
				ext += size
			}
		}
		blockEnd += 2 + n*12 + 4 + ext
	}
	stripCursor := blockEnd
	for i := range plans {
		offs := make([]uint32, 0, len(plans[i].strips))
		counts := make([]uint32, 0, len(plans[i].strips))
		for _, s := range plans[i].strips {
			offs = append(offs, uint32(stripCursor))
			counts = append(counts, uint32(len(s.data)))
			stripCursor += len(s.data)
		}
		plans[i].entries = append(plans[i].entries,
			tagValue{tag: tagStripOffsets, typ: typeLong, count: uint32(len(offs)), values: offs},
			tagValue{tag: tagStripByteCounts, typ: typeLong, count: uint32(len(counts)), values: counts},
		)
		sortEntries(plans[i].entries)
	}
	return blockEnd
}

func mustParse(t *testing.T, data []byte) *Reader {
	t.Helper()
	r, err := NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	return r
}
