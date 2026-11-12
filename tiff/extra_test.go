package tiff

import (
	"bytes"
	"testing"
)

func TestPackBitsPlanar2(t *testing.T) {
	img := &fixtureImage{
		width: 4, height: 5, bands: 2, planar: 2,
		rowsPerStrip: 2, compression: 32773,
		pixels: makePixels(4, 5, 2, 2),
	}
	r := mustParse(t, newFixture(true, img).build())
	im, _ := r.Image(0)
	rect := Rect{X: 1, Y: 1, Width: 3, Height: 4}
	got, err := im.ReadRect(rect, []int{0, 1})
	if err != nil {
		t.Fatal(err)
	}
	want := expectedRect(4, 5, 2, 2, rect, []int{0, 1})
	if !bytes.Equal(got, want) {
		t.Fatalf("planar2 packbits mismatch\n got %v\nwant %v", got, want)
	}
}

func TestMinimalIFDDefaults(t *testing.T) {
	// No 259/277/278/284 tags: all take their defaults.
	f := newFixture(true, &fixtureImage{
		width: 2, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 1,
		pixels: makePixels(2, 3, 1, 1),
	})
	plans := make([]ifdPlan, 1)
	img := f.images[0]
	entries := []tagValue{
		{tag: tagImageWidth, typ: typeShort, count: 1, values: []uint32{2}},
		{tag: tagImageLength, typ: typeShort, count: 1, values: []uint32{3}},
		{tag: tagBitsPerSample, typ: typeShort, count: 1, values: []uint32{8}},
	}
	plans[0] = ifdPlan{entries: entries, strips: buildStrips(f, img), img: img}
	f.appendStripArrays(plans)

	var b bytes.Buffer
	b.WriteString("II")
	f.put16(&b, 42)
	f.put32(&b, 8)
	f.put16(&b, uint16(len(plans[0].entries)))
	for _, e := range plans[0].entries {
		f.put16(&b, e.tag)
		f.put16(&b, e.typ)
		f.put32(&b, e.count)
		var field [4]byte
		buf := bytes.NewBuffer(field[:0])
		f.encodeValues(buf, e)
		copy(field[:], buf.Bytes())
		b.Write(field[:])
	}
	f.put32(&b, 0)
	for _, s := range plans[0].strips {
		b.Write(s.data)
	}

	r := mustParse(t, b.Bytes())
	im, _ := r.Image(0)
	if im.Bands != 1 || im.PlanarConfig != 1 || im.RowsPerStrip != 3 || im.Compression != 1 {
		t.Fatalf("defaults not applied: %+v", im)
	}
	got, err := im.ReadRect(Rect{Width: 2, Height: 3}, []int{0})
	if err != nil {
		t.Fatal(err)
	}
	want := expectedRect(2, 3, 1, 1, Rect{Width: 2, Height: 3}, []int{0})
	if !bytes.Equal(got, want) {
		t.Fatalf("minimal IFD mismatch\n got %v\nwant %v", got, want)
	}
}

func TestIFDOffsetBeyondEOF(t *testing.T) {
	img := &fixtureImage{
		width: 2, height: 2, bands: 1, planar: 1,
		rowsPerStrip: 2, compression: 1,
		pixels: makePixels(2, 2, 1, 1),
	}
	data := newFixture(true, img).build()
	bad := append([]byte(nil), data...)
	bad[4] = 0xff
	bad[5] = 0xff
	bad[6] = 0xff
	bad[7] = 0x7f
	if _, err := NewReader(bytes.NewReader(bad), int64(len(bad))); err == nil {
		t.Fatal("expected out-of-range first IFD error")
	}
}

func TestTruncatedExternalArray(t *testing.T) {
	// 3 bands => 6-byte BitsPerSample stored externally; cut its tail.
	img := &fixtureImage{
		width: 2, height: 2, bands: 3, planar: 2,
		rowsPerStrip: 2, compression: 1,
		pixels: makePixels(2, 2, 3, 2),
	}
	data := newFixture(true, img).build()
	r := mustParse(t, data)
	off := int(r.images[0].entries[tagBitsPerSample].externalOff)
	short := data[:off+3]
	if _, err := NewReader(bytes.NewReader(short), int64(len(short))); err == nil {
		t.Fatal("expected external array truncation error")
	}
}
