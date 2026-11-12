package tiff

import (
	"bytes"
	"strings"
	"testing"
)

func TestIFDCycleRejected(t *testing.T) {
	first := &fixtureImage{
		width: 2, height: 2, bands: 1, planar: 1,
		rowsPerStrip: 2, compression: 1,
		pixels: makePixels(2, 2, 1, 1),
	}
	second := &fixtureImage{
		width: 2, height: 2, bands: 1, planar: 1,
		rowsPerStrip: 2, compression: 1, cycleBack: 0, cycleSet: true,
		pixels: makePixels(2, 2, 1, 1),
	}
	data := newFixture(true, first, second).build()
	if _, err := NewReader(bytes.NewReader(data), int64(len(data))); err == nil ||
		!strings.Contains(err.Error(), "cycle") {
		t.Fatalf("expected cycle error, got %v", err)
	}
}

func TestTruncationRejected(t *testing.T) {
	img := &fixtureImage{
		width: 4, height: 4, bands: 1, planar: 1,
		rowsPerStrip: 4, compression: 1, truncateAt: 12,
		pixels: makePixels(4, 4, 1, 1),
	}
	data := newFixture(true, img).build()
	if _, err := NewReader(bytes.NewReader(data), int64(len(data))); err == nil {
		t.Fatal("expected truncation error")
	}
}

func TestDuplicateTagRejected(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 1, dupTag: true,
		pixels: makePixels(3, 3, 1, 1),
	}
	data := newFixture(true, img).build()
	_, err := NewReader(bytes.NewReader(data), int64(len(data)))
	if err == nil || !strings.Contains(err.Error(), "duplicate tag") {
		t.Fatalf("expected duplicate tag error, got %v", err)
	}
}

func TestUnknownTagValidatedButSkipped(t *testing.T) {
	img := &fixtureImage{
		width: 3, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 1,
		unknownTag: true, unknownCount: 6,
		pixels: makePixels(3, 3, 1, 1),
	}
	data := newFixture(true, img).build()
	r := mustParse(t, data)
	if _, ok := r.images[0].entries[700]; !ok {
		t.Fatal("unknown tag entry should still be recorded")
	}

	// Same tag, but point its external data past EOF.
	bad := &fixtureImage{
		width: 3, height: 3, bands: 1, planar: 1,
		rowsPerStrip: 3, compression: 1,
		unknownTag: true, unknownCount: 200,
		pixels: makePixels(3, 3, 1, 1),
	}
	badData := newFixture(true, bad).build()
	if _, err := NewReader(bytes.NewReader(badData), int64(len(badData))-40); err == nil {
		t.Fatal("expected out-of-range unknown tag value to be rejected")
	}
}

func TestRectangleValidation(t *testing.T) {
	img := &fixtureImage{
		width: 4, height: 4, bands: 2, planar: 1,
		rowsPerStrip: 4, compression: 1,
		pixels: makePixels(4, 4, 2, 1),
	}
	r := mustParse(t, newFixture(true, img).build())
	im, _ := r.Image(0)
	cases := []struct {
		name  string
		rect  Rect
		bands []int
	}{
		{"empty rect", Rect{Width: 0, Height: 1}, []int{0}},
		{"outside x", Rect{X: 3, Y: 0, Width: 2, Height: 1}, []int{0}},
		{"outside y", Rect{X: 0, Y: 4, Width: 1, Height: 1}, []int{0}},
		{"negative origin", Rect{X: -1, Y: 0, Width: 1, Height: 1}, []int{0}},
		{"bad band", Rect{Width: 1, Height: 1}, []int{2}},
		{"no bands", Rect{Width: 1, Height: 1}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := im.ReadRect(tc.rect, tc.bands); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestBadHeader(t *testing.T) {
	cases := map[string][]byte{
		"too short":  make([]byte, 4),
		"bad mark":   append([]byte("XX"), 0, 42, 0, 0, 0, 8),
		"bad magic":  append([]byte("II"), 0, 43, 0, 0, 0, 8),
		"zero ifd":   append([]byte("II"), 0, 42, 0, 0, 0, 0),
		"ifd beyond": append([]byte("II"), 0, 42, 0xff, 0xff, 0xff, 0xff),
	}
	for name, data := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := NewReader(bytes.NewReader(data), int64(len(data))); err == nil {
				t.Fatal("expected header error")
			}
		})
	}
}

func TestLimits(t *testing.T) {
	img := &fixtureImage{
		width: 8, height: 8, bands: 1, planar: 1,
		rowsPerStrip: 8, compression: 1,
		pixels: makePixels(8, 8, 1, 1),
	}
	data := newFixture(true, img).build()
	lim := DefaultLimits
	lim.MaxOutputPixels = 10
	r, err := NewReaderWithLimits(bytes.NewReader(data), int64(len(data)), lim)
	if err != nil {
		t.Fatal(err)
	}
	im, _ := r.Image(0)
	if _, err := im.ReadRect(Rect{Width: 4, Height: 4}, []int{0}); err == nil ||
		!strings.Contains(err.Error(), "output samples") {
		t.Fatalf("expected output limit error, got %v", err)
	}

	small := DefaultLimits
	small.MaxIFDEntries = 2
	if _, err := NewReaderWithLimits(bytes.NewReader(data), int64(len(data)), small); err == nil {
		t.Fatal("expected entry limit error")
	}
}
