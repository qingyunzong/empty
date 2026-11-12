package tiff

import (
	"bytes"
	"testing"
)

func makePixels(w, h, bands, planar int) []byte {
	if planar == 1 {
		out := make([]byte, w*h*bands)
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				for b := 0; b < bands; b++ {
					out[(y*w+x)*bands+b] = pixelValue(x, y, b, bands)
				}
			}
		}
		return out
	}
	out := make([]byte, bands*w*h)
	for b := 0; b < bands; b++ {
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				out[b*w*h+y*w+x] = pixelValue(x, y, b, bands)
			}
		}
	}
	return out
}

func pixelValue(x, y, band, bands int) byte {
	return byte((x*7 + y*13 + band*29 + bands*3) & 0xff)
}

func expectedRect(w, h, bands, planar int, rect Rect, reqBands []int) []byte {
	out := make([]byte, rect.Width*rect.Height*len(reqBands))
	for y := 0; y < rect.Height; y++ {
		for x := 0; x < rect.Width; x++ {
			sx, sy := rect.X+x, rect.Y+y
			for oi, b := range reqBands {
				out[(y*rect.Width+x)*len(reqBands)+oi] = pixelValue(sx, sy, b, bands)
			}
		}
	}
	return out
}

func TestEndianRoundTrip(t *testing.T) {
	for _, little := range []bool{true, false} {
		name := "big"
		if little {
			name = "little"
		}
		t.Run(name, func(t *testing.T) {
			img := &fixtureImage{
				width: 6, height: 5, bands: 1, planar: 1,
				rowsPerStrip: 5, compression: 1,
				pixels: makePixels(6, 5, 1, 1),
			}
			data := newFixture(little, img).build()
			r := mustParse(t, data)
			if r.Images() != 1 {
				t.Fatalf("Images = %d, want 1", r.Images())
			}
			im, err := r.Image(0)
			if err != nil {
				t.Fatal(err)
			}
			if im.Width != 6 || im.Height != 5 || im.Bands != 1 {
				t.Fatalf("metadata = %+v", im)
			}
			rect := Rect{X: 1, Y: 1, Width: 3, Height: 2}
			got, err := im.ReadRect(rect, []int{0})
			if err != nil {
				t.Fatalf("ReadRect: %v", err)
			}
			want := expectedRect(6, 5, 1, 1, rect, []int{0})
			if !bytes.Equal(got, want) {
				t.Fatalf("rect mismatch\n got %v\nwant %v", got, want)
			}
		})
	}
}

func TestMultipleIFDs(t *testing.T) {
	first := &fixtureImage{
		width: 4, height: 4, bands: 1, planar: 1,
		rowsPerStrip: 4, compression: 1,
		pixels: makePixels(4, 4, 1, 1),
	}
	second := &fixtureImage{
		width: 3, height: 2, bands: 1, planar: 1,
		rowsPerStrip: 2, compression: 1,
		pixels: makePixels(3, 2, 1, 1),
	}
	data := newFixture(true, first, second).build()
	r := mustParse(t, data)
	if r.Images() != 2 {
		t.Fatalf("Images = %d, want 2", r.Images())
	}
	if _, err := r.Image(2); err == nil {
		t.Fatal("expected out-of-range error")
	}
	im, _ := r.Image(1)
	got, err := im.ReadRect(Rect{X: 0, Y: 0, Width: 3, Height: 2}, []int{0})
	if err != nil {
		t.Fatal(err)
	}
	want := expectedRect(3, 2, 1, 1, Rect{Width: 3, Height: 2}, []int{0})
	if !bytes.Equal(got, want) {
		t.Fatalf("second IFD mismatch\n got %v\nwant %v", got, want)
	}
}

func TestMultiIFDMultiStripsLayout(t *testing.T) {
	a := &fixtureImage{
		width: 3, height: 5, bands: 2, planar: 1,
		rowsPerStrip: 2, compression: 1,
		pixels: makePixels(3, 5, 2, 1),
	}
	b := &fixtureImage{
		width: 4, height: 7, bands: 3, planar: 2,
		rowsPerStrip: 3, compression: 1,
		pixels: makePixels(4, 7, 3, 2),
	}
	data := newFixture(false, a, b).build()
	r := mustParse(t, data)
	if r.Images() != 2 {
		t.Fatalf("Images = %d", r.Images())
	}
	im0, _ := r.Image(0)
	got0, err := im0.ReadRect(Rect{X: 1, Y: 1, Width: 2, Height: 4}, []int{1, 0})
	if err != nil {
		t.Fatalf("IFD0: %v", err)
	}
	want0 := expectedRect(3, 5, 2, 1, Rect{X: 1, Y: 1, Width: 2, Height: 4}, []int{1, 0})
	if !bytes.Equal(got0, want0) {
		t.Fatalf("IFD0 mismatch\n got %v\nwant %v", got0, want0)
	}
	im1, _ := r.Image(1)
	got1, err := im1.ReadRect(Rect{X: 0, Y: 2, Width: 4, Height: 5}, []int{2})
	if err != nil {
		t.Fatalf("IFD1: %v", err)
	}
	want1 := expectedRect(4, 7, 3, 2, Rect{X: 0, Y: 2, Width: 4, Height: 5}, []int{2})
	if !bytes.Equal(got1, want1) {
		t.Fatalf("IFD1 mismatch\n got %v\nwant %v", got1, want1)
	}
}

func TestInlineShortArray(t *testing.T) {
	// Two bands: BitsPerSample = [8,8] is 4 bytes, stored inline.
	img := &fixtureImage{
		width: 4, height: 3, bands: 2, planar: 1,
		rowsPerStrip: 3, compression: 1,
		pixels: makePixels(4, 3, 2, 1),
	}
	data := newFixture(true, img).build()
	r := mustParse(t, data)
	en := r.images[0].entries[tagBitsPerSample]
	if en.isExternal {
		t.Fatal("BitsPerSample[8,8] should be inline")
	}
	im, _ := r.Image(0)
	got, err := im.ReadRect(Rect{X: 1, Y: 0, Width: 2, Height: 3}, []int{1, 0, 1})
	if err != nil {
		t.Fatal(err)
	}
	want := expectedRect(4, 3, 2, 1, Rect{X: 1, Y: 0, Width: 2, Height: 3}, []int{1, 0, 1})
	if !bytes.Equal(got, want) {
		t.Fatalf("band reorder mismatch\n got %v\nwant %v", got, want)
	}
}

func TestPlanar2BandOrder(t *testing.T) {
	img := &fixtureImage{
		width: 5, height: 4, bands: 3, planar: 2,
		rowsPerStrip: 2, compression: 1,
		pixels: makePixels(5, 4, 3, 2),
	}
	data := newFixture(false, img).build()
	r := mustParse(t, data)
	if r.images[0].Strips != 6 {
		t.Fatalf("Strips = %d, want 6", r.images[0].Strips)
	}
	en := r.images[0].entries[tagBitsPerSample]
	if !en.isExternal || en.bytes != 6 {
		t.Fatalf("BitsPerSample should be external 6 bytes, got external=%v bytes=%d", en.isExternal, en.bytes)
	}
	bits, err := r.images[0].uint32Array(tagBitsPerSample)
	if err != nil || len(bits) != 3 {
		t.Fatalf("external SHORT array read failed: %v %v", bits, err)
	}
	im, _ := r.Image(0)
	rect := Rect{X: 2, Y: 1, Width: 2, Height: 3}
	got, err := im.ReadRect(rect, []int{2, 0})
	if err != nil {
		t.Fatal(err)
	}
	want := expectedRect(5, 4, 3, 2, rect, []int{2, 0})
	if !bytes.Equal(got, want) {
		t.Fatalf("planar2 mismatch\n got %v\nwant %v", got, want)
	}
}

func TestPartialLastStrip(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 5, bands: 2, planar: 1,
		rowsPerStrip: 2, compression: 1,
		pixels: makePixels(3, 5, 2, 1),
	}
	data := newFixture(true, img).build()
	r := mustParse(t, data)
	if r.images[0].stripRows[2] != 1 {
		t.Fatalf("last strip rows = %d, want 1", r.images[0].stripRows[2])
	}
	im, _ := r.Image(0)
	rect := Rect{X: 0, Y: 2, Width: 3, Height: 3}
	got, err := im.ReadRect(rect, []int{0, 1})
	if err != nil {
		t.Fatal(err)
	}
	want := expectedRect(3, 5, 2, 1, rect, []int{0, 1})
	if !bytes.Equal(got, want) {
		t.Fatalf("partial strip mismatch\n got %v\nwant %v", got, want)
	}
}

func TestPlanar2PartialLastStrip(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 5, bands: 2, planar: 2,
		rowsPerStrip: 2, compression: 1,
		pixels: makePixels(3, 5, 2, 2),
	}
	data := newFixture(true, img).build()
	r := mustParse(t, data)
	if r.images[0].Strips != 6 || r.images[0].stripRows[2] != 1 || r.images[0].stripRows[5] != 1 {
		t.Fatalf("unexpected strip geometry: %+v", r.images[0].stripRows)
	}
	im, _ := r.Image(0)
	rect := Rect{X: 1, Y: 3, Width: 2, Height: 2}
	got, err := im.ReadRect(rect, []int{1})
	if err != nil {
		t.Fatal(err)
	}
	want := expectedRect(3, 5, 2, 2, rect, []int{1})
	if !bytes.Equal(got, want) {
		t.Fatalf("planar2 partial mismatch\n got %v\nwant %v", got, want)
	}
}

func TestRepeatedBandsPreserveOrder(t *testing.T) {
	img := &fixtureImage{
		width: 2, height: 2, bands: 3, planar: 1,
		rowsPerStrip: 2, compression: 1,
		pixels: makePixels(2, 2, 3, 1),
	}
	r := mustParse(t, newFixture(true, img).build())
	im, _ := r.Image(0)
	got, err := im.ReadRect(Rect{Width: 2, Height: 2}, []int{2, 2, 0})
	if err != nil {
		t.Fatal(err)
	}
	want := expectedRect(2, 2, 3, 1, Rect{Width: 2, Height: 2}, []int{2, 2, 0})
	if !bytes.Equal(got, want) {
		t.Fatalf("repeated band mismatch\n got %v\nwant %v", got, want)
	}
}
