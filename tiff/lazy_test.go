package tiff

import (
	"bytes"
	"testing"
)

type countingReaderAt struct {
	data    []byte
	reads   int
	touched map[int64]bool
}

func (c *countingReaderAt) ReadAt(p []byte, off int64) (int, error) {
	c.reads++
	if c.touched == nil {
		c.touched = map[int64]bool{}
	}
	for i := range p {
		c.touched[off+int64(i)] = true
	}
	return copy(p, c.data[off:]), nil
}

func TestUnrelatedStripsNotRead(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 5, bands: 1, planar: 1,
		rowsPerStrip: 2, compression: 1,
		pixels: makePixels(3, 5, 1, 1),
	}
	data := newFixture(true, img).build()
	cr := &countingReaderAt{data: data}
	r, err := NewReader(cr, int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	im, _ := r.Image(0)
	if _, err := im.ReadRect(Rect{X: 0, Y: 2, Width: 3, Height: 2}, []int{0}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < im.Strips; i++ {
		off := int64(im.stripOffsets[i])
		end := off + int64(im.stripByteCount[i])
		touched := cr.touched[off] || cr.touched[end-1]
		wantTouched := i == 1
		if touched != wantTouched {
			t.Errorf("strip %d touched=%v, want %v", i, touched, wantTouched)
		}
	}
}

func TestBadStripFailsWholeRect(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 6, bands: 1, planar: 1,
		rowsPerStrip: 2, compression: 32773,
		pixels: makePixels(3, 6, 1, 1),
	}
	data := newFixture(true, img).build()
	r := mustParse(t, data)
	im, _ := r.Image(0)

	// Corrupt the middle strip so PackBits decoding fails; parse already
	// succeeded because compressed payloads are validated lazily on read.
	corrupt := append([]byte(nil), data...)
	target := int(im.stripOffsets[1])
	corrupt[target] = 0x7F // literal claiming 128 bytes, strip is far shorter

	r2 := mustParse(t, corrupt)
	im2, _ := r2.Image(0)
	got, err := im2.ReadRect(Rect{X: 0, Y: 0, Width: 3, Height: 6}, []int{0})
	if err == nil {
		t.Fatal("expected corrupt strip error")
	}
	if got != nil {
		t.Fatalf("expected no partial rectangle, got %d bytes", len(got))
	}

	// A rectangle touching only the untouched strips still succeeds.
	ok, err := im.ReadRect(Rect{X: 0, Y: 0, Width: 3, Height: 2}, []int{0})
	if err != nil {
		t.Fatalf("unrelated strip failure leaked: %v", err)
	}
	want := expectedRect(3, 6, 1, 1, Rect{Width: 3, Height: 2}, []int{0})
	if !bytes.Equal(ok, want) {
		t.Fatal("untouched strip rectangle mismatch")
	}
}
