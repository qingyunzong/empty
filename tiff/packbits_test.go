package tiff

import (
	"bytes"
	"strings"
	"testing"
)

func TestPackBitsNoopAndLineBoundary(t *testing.T) {
	img := &fixtureImage{
		width: 4, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 32773,
		pixels: makePixels(4, 3, 1, 1),
	}
	data := newFixture(true, img).build()
	r := mustParse(t, data)
	im, _ := r.Image(0)
	got, err := im.ReadRect(Rect{X: 0, Y: 0, Width: 4, Height: 3}, []int{0})
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	want := expectedRect(4, 3, 1, 1, Rect{Width: 4, Height: 3}, []int{0})
	if !bytes.Equal(got, want) {
		t.Fatalf("packbits mismatch\n got %v\nwant %v", got, want)
	}
}

func TestPackBitsRuns(t *testing.T) {
	// Uniform rows force long runs; include a no-op per row.
	pixels := make([]byte, 4*3)
	for i := range pixels {
		pixels[i] = 0xAB
	}
	img := &fixtureImage{
		width: 4, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 32773, pixels: pixels,
	}
	data := newFixture(false, img).build()
	r := mustParse(t, data)
	im, _ := r.Image(0)
	got, err := im.ReadRect(Rect{Width: 4, Height: 3}, []int{0})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, pixels) {
		t.Fatalf("run mismatch\n got %v\nwant %v", got, pixels)
	}
}

func TestPackBitsRejectsCrossLine(t *testing.T) {
	img := &fixtureImage{
		width: 4, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 32773, crossLine: true,
		pixels: makePixels(4, 3, 1, 1),
	}
	data := newFixture(true, img).build()
	r := mustParse(t, data)
	im, _ := r.Image(0)
	_, err := im.ReadRect(Rect{Width: 4, Height: 3}, []int{0})
	if err == nil || !strings.Contains(err.Error(), "row boundary") {
		t.Fatalf("expected row boundary error, got %v", err)
	}
}

func TestPackBitsDecoderDirect(t *testing.T) {
	// Two rows of 3 bytes: no-op, literal row, no-op, run row.
	src := []byte{
		0x80, 0x02, 1, 2, 3,
		0x80, 0xFE, 9, // run of 3 nines (n=-2)
	}
	got, err := decodePackBits(src, 3, 2)
	if err != nil {
		t.Fatal(err)
	}
	want := []byte{1, 2, 3, 9, 9, 9}
	if !bytes.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if _, err := decodePackBits([]byte{0x02, 1, 2}, 3, 1); err == nil {
		t.Fatal("expected truncated literal error")
	}
	if _, err := decodePackBits([]byte{0x00, 1, 0x00, 2}, 3, 1); err == nil {
		t.Fatal("expected wrong-length error")
	}
	if _, err := decodePackBits([]byte{0x80}, 3, 1); err == nil {
		t.Fatal("expected empty output error")
	}
}
