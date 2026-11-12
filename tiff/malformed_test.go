package tiff

import (
	"bytes"
	"testing"
)

// mutateIFD returns a copy of data with the first entry matching tag rewritten
// to the given type/count/value field.
func mutateIFD(data []byte, little bool, tag uint16, typ uint16, count uint32, value uint32) []byte {
	order := orderFor(little)
	out := append([]byte(nil), data...)
	off := int(order.Uint32(out[4:8]))
	n := int(order.Uint16(out[off:]))
	for i := 0; i < n; i++ {
		base := off + 2 + i*12
		if order.Uint16(out[base:]) != tag {
			continue
		}
		order.PutUint16(out[base+2:], typ)
		order.PutUint32(out[base+4:], count)
		order.PutUint32(out[base+8:], value)
		return out
	}
	panic("tag not found")
}

func TestUnknownTypeRejected(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 1,
		pixels: makePixels(3, 3, 1, 1),
	}
	data := newFixture(true, img).build()
	bad := mutateIFD(data, true, tagRowsPerStrip, 9, 1, 3)
	if _, err := NewReader(bytes.NewReader(bad), int64(len(bad))); err == nil {
		t.Fatal("expected unknown type error")
	}
}

func TestBitsPerSampleMustBeShort(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 1,
		pixels: makePixels(3, 3, 1, 1),
	}
	data := newFixture(true, img).build()
	bad := mutateIFD(data, true, tagBitsPerSample, typeLong, 1, 8)
	if _, err := NewReader(bytes.NewReader(bad), int64(len(bad))); err == nil {
		t.Fatal("expected LONG BitsPerSample error")
	}
}

func TestScalarCountMustBeOne(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 1,
		pixels: makePixels(3, 3, 1, 1),
	}
	data := newFixture(true, img).build()
	// Rewrite width as an (invalid) two-element SHORT.
	bad := mutateIFD(data, true, tagImageWidth, typeShort, 2, 3)
	if _, err := NewReader(bytes.NewReader(bad), int64(len(bad))); err == nil {
		t.Fatal("expected scalar count error")
	}
}

func TestZeroRowsPerStripRejected(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 1,
		pixels: makePixels(3, 3, 1, 1),
	}
	data := newFixture(true, img).build()
	bad := mutateIFD(data, true, tagRowsPerStrip, typeShort, 1, 0)
	if _, err := NewReader(bytes.NewReader(bad), int64(len(bad))); err == nil {
		t.Fatal("expected zero RowsPerStrip error")
	}
}

func TestUnsupportedCompressionRejected(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 32773,
		pixels: makePixels(3, 3, 1, 1),
	}
	data := newFixture(true, img).build()
	bad := mutateIFD(data, true, tagCompression, typeShort, 1, 5)
	if _, err := NewReader(bytes.NewReader(bad), int64(len(bad))); err == nil {
		t.Fatal("expected compression error")
	}
}

func TestBadPlanarConfigRejected(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 3, bands: 2, planar: 1,
		rowsPerStrip: 3, compression: 1,
		pixels: makePixels(3, 3, 2, 1),
	}
	data := newFixture(true, img).build()
	bad := mutateIFD(data, true, tagPlanarConfig, typeShort, 1, 3)
	if _, err := NewReader(bytes.NewReader(bad), int64(len(bad))); err == nil {
		t.Fatal("expected planar config error")
	}
}

func TestArrayTagRejectsByteType(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 1,
		pixels: makePixels(3, 3, 1, 1),
	}
	data := newFixture(true, img).build()
	// StripOffsets as BYTE is illegal even if the offset fits in one byte.
	bad := mutateIFD(data, true, tagStripOffsets, typeByte, 1, uint32(len(data)-4))
	if _, err := NewReader(bytes.NewReader(bad), int64(len(bad))); err == nil {
		t.Fatal("expected BYTE array tag error")
	}
}

func TestNegativeBandIndexRejected(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 1,
		pixels: makePixels(3, 3, 1, 1),
	}
	r := mustParse(t, newFixture(true, img).build())
	im, _ := r.Image(0)
	if _, err := im.ReadRect(Rect{Width: 1, Height: 1}, []int{-1}); err == nil {
		t.Fatal("expected negative band error")
	}
}
