package dataeng_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"math/big"
	"testing"

	dataeng "example.org/dataeng/q0252"
)

func TestHeaderSpansMultipleBlocksAndPreservesUnknownCards(t *testing.T) {
	var cards []testCard
	for i := 0; i < 20; i++ {
		cards = append(cards, testCard{keyword: fmt.Sprintf("X%03d", i), value: fmt.Sprint(i), comment: "unknown"})
	}
	cards = append(cards,
		testCard{keyword: "SIMPLE", value: "T", comment: "primary"},
		testCard{keyword: "BITPIX", value: "16"},
		testCard{keyword: "NAXIS", value: "2"},
	)
	for i := 20; i < 40; i++ {
		cards = append(cards, testCard{keyword: fmt.Sprintf("X%03d", i), value: fmt.Sprint(i)})
	}
	cards = append(cards,
		testCard{keyword: "NAXIS1", value: "3"},
		testCard{keyword: "NAXIS2", value: "2"},
	)

	values := []int64{-5, 7, 100, -200, 300, -400}
	file := fileBytes(t, cards, encodeSamples(t, 16, values))
	image := openBytes(t, file)

	if image.DataOffset() != 5760 {
		t.Fatalf("data offset = %d, want 5760", image.DataOffset())
	}
	if got := image.Shape(); len(got) != 2 || got[0] != 3 || got[1] != 2 {
		t.Fatalf("shape = %v", got)
	}
	card, ok := image.Header().Lookup("X039")
	if !ok || card.Value != "39" {
		t.Fatalf("unknown card X039 = %#v, present=%v", card, ok)
	}

	samples, err := image.ReadRect([]int64{0, 0}, []int64{3, 2})
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	requireRawSamples(t, samples, values)
}

func TestBlankIsCheckedBeforeScaling(t *testing.T) {
	cards := requiredCards(16, 5)
	cards = append(cards,
		testCard{keyword: "BLANK", value: "-999"},
		testCard{keyword: "BSCALE", value: "-0.25"},
		testCard{keyword: "BZERO", value: "10.5"},
	)
	values := []int64{-999, 0, 4, -4, 32767}
	file := fileBytes(t, cards, encodeSamples(t, 16, values))
	image := openBytes(t, file)

	samples, err := image.ReadRect([]int64{0}, []int64{5})
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	requireRawSamples(t, samples, values)
	if !samples[0].Missing || samples[0].Physical != nil {
		t.Fatalf("BLANK sample missing=%v physical=%v", samples[0].Missing, samples[0].Physical)
	}
	requirePhysical(t, samples[1].Physical, "10.5")
	requirePhysical(t, samples[2].Physical, "9.5")
	requirePhysical(t, samples[3].Physical, "11.5")
	requirePhysical(t, samples[4].Physical, "-8181.25")
	for i := 1; i < len(samples); i++ {
		if samples[i].Missing {
			t.Fatalf("sample %d unexpectedly missing", i)
		}
	}
}

func TestNegativeBScaleWithUnsignedBytes(t *testing.T) {
	cards := requiredCards(8, 4)
	cards = append(cards,
		testCard{keyword: "BSCALE", value: "-2.5"},
		testCard{keyword: "BZERO", value: "100"},
	)
	values := []int64{0, 1, 200, 255}
	file := fileBytes(t, cards, encodeSamples(t, 8, values))
	image := openBytes(t, file)

	samples, err := image.ReadRect([]int64{0}, []int64{4})
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	requireRawSamples(t, samples, values)
	requirePhysical(t, samples[0].Physical, "100")
	requirePhysical(t, samples[1].Physical, "97.5")
	requirePhysical(t, samples[2].Physical, "-400")
	requirePhysical(t, samples[3].Physical, "-537.5")
}

func TestInt64ExtremaRemainExact(t *testing.T) {
	cards := requiredCards(64, 2)
	cards = append(cards,
		testCard{keyword: "BZERO", value: "9223372036854775807"},
		testCard{keyword: "BSCALE", value: "1"},
	)
	values := []int64{math.MinInt64, math.MaxInt64}
	file := fileBytes(t, cards, encodeSamples(t, 64, values))
	image := openBytes(t, file)

	samples, err := image.ReadRect([]int64{0}, []int64{2})
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	requireRawSamples(t, samples, values)
	requirePhysical(t, samples[0].Physical, "-1")
	requirePhysical(t, samples[1].Physical, "18446744073709551614")
}

func TestNaXISZeroHasNoSamples(t *testing.T) {
	file := fileBytes(t, requiredCards(8), nil)
	image := openBytes(t, file)

	if image.NAXIS() != 0 || image.PixelCount() != 0 || len(image.Shape()) != 0 {
		t.Fatalf("axes=%d pixels=%d shape=%v", image.NAXIS(), image.PixelCount(), image.Shape())
	}
	if image.DataOffset() != 2880 {
		t.Fatalf("data offset = %d", image.DataOffset())
	}
	samples, err := image.ReadRect(nil, nil)
	if err != nil {
		t.Fatalf("zero-dimensional ReadRect: %v", err)
	}
	if len(samples) != 0 {
		t.Fatalf("zero-dimensional read returned %d samples", len(samples))
	}
	if _, err := image.ReadRect([]int64{0}, []int64{1}); !errors.Is(err, dataeng.ErrInvalidRegion) {
		t.Fatalf("nonempty zero-dimensional region error = %v", err)
	}
}

func TestZeroLengthAxisHasNoData(t *testing.T) {
	file := fileBytes(t, requiredCards(32, 0, 4), nil)
	image := openBytes(t, file)
	shape := image.Shape()
	if len(shape) != 2 || shape[0] != 0 || shape[1] != 4 {
		t.Fatalf("shape = %v", shape)
	}
	samples, err := image.ReadRect([]int64{0, 0}, []int64{0, 4})
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	if len(samples) != 0 {
		t.Fatalf("empty-axis read returned %d samples", len(samples))
	}

	hugeCards := requiredCards(16, math.MaxInt64, math.MaxInt64, 0)
	hugeFile := fileBytes(t, hugeCards, nil)
	hugeImage := openBytes(t, hugeFile)
	empty, err := hugeImage.ReadRect(
		[]int64{0, 0, 0},
		[]int64{math.MaxInt64, math.MaxInt64, 0},
	)
	if err != nil {
		t.Fatalf("huge empty-axis ReadRect: %v", err)
	}
	if len(empty) != 0 {
		t.Fatalf("huge empty-axis read returned %d samples", len(empty))
	}
}

func TestAdjacentRectanglesMatchOneLargerRead(t *testing.T) {
	cards := requiredCards(32, 4, 3)
	values := []int64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12}
	file := fileBytes(t, cards, encodeSamples(t, 32, values))
	image := openBytes(t, file)

	left, err := image.ReadRect([]int64{0, 0}, []int64{2, 2})
	if err != nil {
		t.Fatalf("left ReadRect: %v", err)
	}
	right, err := image.ReadRect([]int64{2, 0}, []int64{4, 2})
	if err != nil {
		t.Fatalf("right ReadRect: %v", err)
	}
	combined, err := image.ReadRect([]int64{0, 0}, []int64{4, 2})
	if err != nil {
		t.Fatalf("combined ReadRect: %v", err)
	}

	requireRawSamples(t, left, []int64{1, 2, 5, 6})
	requireRawSamples(t, right, []int64{3, 4, 7, 8})
	requireRawSamples(t, combined, []int64{1, 2, 3, 4, 5, 6, 7, 8})

	leftWant := append(append([]dataeng.Sample{}, combined[0:2]...), combined[4:6]...)
	rightWant := append(append([]dataeng.Sample{}, combined[2:4]...), combined[6:8]...)
	for i := range leftWant {
		if left[i].Coord[0] != leftWant[i].Coord[0] || left[i].Coord[1] != leftWant[i].Coord[1] || left[i].Raw != leftWant[i].Raw {
			t.Fatalf("left sample %d = %v/%d, want %v/%d", i, left[i].Coord, left[i].Raw, leftWant[i].Coord, leftWant[i].Raw)
		}
	}
	for i := range rightWant {
		if right[i].Coord[0] != rightWant[i].Coord[0] || right[i].Coord[1] != rightWant[i].Coord[1] || right[i].Raw != rightWant[i].Raw {
			t.Fatalf("right sample %d = %v/%d, want %v/%d", i, right[i].Coord, right[i].Raw, rightWant[i].Coord, rightWant[i].Raw)
		}
	}

	allCoords, err := image.ReadRect([]int64{0, 0}, []int64{4, 3})
	if err != nil {
		t.Fatalf("full ReadRect: %v", err)
	}
	for i := 0; i < 12; i++ {
		wantX := int64(i % 4)
		wantY := int64(i / 4)
		if allCoords[i].Coord[0] != wantX || allCoords[i].Coord[1] != wantY {
			t.Fatalf("sample %d coord=%v, want [%d %d]", i, allCoords[i].Coord, wantX, wantY)
		}
	}

	top, err := image.ReadRect([]int64{0, 0}, []int64{4, 1})
	if err != nil {
		t.Fatalf("top ReadRect: %v", err)
	}
	bottom, err := image.ReadRect([]int64{0, 1}, []int64{4, 2})
	if err != nil {
		t.Fatalf("bottom ReadRect: %v", err)
	}
	joinedRows := append(append([]dataeng.Sample{}, top...), bottom...)
	for i := range combined {
		if joinedRows[i].Coord[0] != combined[i].Coord[0] || joinedRows[i].Coord[1] != combined[i].Coord[1] || joinedRows[i].Raw != combined[i].Raw {
			t.Fatalf("row-adjacent sample %d = %v/%d, want %v/%d", i, joinedRows[i].Coord, joinedRows[i].Raw, combined[i].Coord, combined[i].Raw)
		}
	}
}

func TestThreeDimensionalOrdering(t *testing.T) {
	cards := requiredCards(16, 2, 2, 2)
	values := []int64{1, 2, 3, 4, 5, 6, 7, 8}
	file := fileBytes(t, cards, encodeSamples(t, 16, values))
	image := openBytes(t, file)

	samples, err := image.ReadRect([]int64{0, 0, 0}, []int64{2, 2, 2})
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	requireRawSamples(t, samples, values)
	wantCoords := [][3]int64{
		{0, 0, 0}, {1, 0, 0},
		{0, 1, 0}, {1, 1, 0},
		{0, 0, 1}, {1, 0, 1},
		{0, 1, 1}, {1, 1, 1},
	}
	for i, want := range wantCoords {
		if samples[i].Coord[0] != want[0] || samples[i].Coord[1] != want[1] || samples[i].Coord[2] != want[2] {
			t.Fatalf("sample %d coord=%v, want %v", i, samples[i].Coord, want)
		}
	}

	slice, err := image.ReadRect([]int64{1, 0, 0}, []int64{2, 2, 1})
	if err != nil {
		t.Fatalf("subvolume ReadRect: %v", err)
	}
	requireRawSamples(t, slice, []int64{2, 4})
	if slice[0].Coord[0] != 1 || slice[0].Coord[1] != 0 || slice[0].Coord[2] != 0 ||
		slice[1].Coord[0] != 1 || slice[1].Coord[1] != 1 || slice[1].Coord[2] != 0 {
		t.Fatalf("subvolume coords = %v, %v", slice[0].Coord, slice[1].Coord)
	}
}

func TestAllRawDecodersAndDataBlockBoundary(t *testing.T) {
	tests := []struct {
		name   string
		bitpix int
		values []int64
	}{
		{name: "8", bitpix: 8, values: []int64{0, 1, 128, 255}},
		{name: "16", bitpix: 16, values: []int64{-32768, -1, 0, 32767}},
		{name: "32", bitpix: 32, values: []int64{-2147483648, -1, 0, 2147483647}},
		{name: "64", bitpix: 64, values: []int64{math.MinInt64, -1, 0, math.MaxInt64}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cards := requiredCards(test.bitpix, 1601)
			values := make([]int64, 1601)
			values[0] = test.values[0]
			values[1] = test.values[1]
			values[2] = test.values[2]
			values[1600] = test.values[3]
			for i := 3; i < 1600; i++ {
				if test.bitpix == 8 {
					values[i] = int64(i % 256)
				} else {
					values[i] = int64(i)
				}
			}
			file := fileBytes(t, cards, encodeSamples(t, test.bitpix, values))
			image := openBytes(t, file)
			samples, err := image.ReadRect([]int64{0}, []int64{1601})
			if err != nil {
				t.Fatalf("ReadRect: %v", err)
			}
			requireRawSamples(t, samples, values)
		})
	}
}

func TestPhysicalValueIsCanonicalRational(t *testing.T) {
	cards := requiredCards(16, 1)
	cards = append(cards,
		testCard{keyword: "BSCALE", value: "0.50"},
		testCard{keyword: "BZERO", value: "1.25"},
	)
	file := fileBytes(t, cards, encodeSamples(t, 16, []int64{3}))
	image := openBytes(t, file)
	samples, err := image.ReadRect([]int64{0}, []int64{1})
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	requirePhysical(t, samples[0].Physical, "2.75")
	if samples[0].Physical.RatString() != "11/4" {
		t.Fatalf("physical not canonical: %s", samples[0].Physical.RatString())
	}
}

func TestValueSyntaxAcceptsSignedAndFiniteDecimals(t *testing.T) {
	cards := requiredCards(16, 1)
	cards = append(cards,
		testCard{keyword: "BSCALE", value: "+0.250"},
		testCard{keyword: "BZERO", value: "-7.0"},
	)
	file := fileBytes(t, cards, encodeSamples(t, 16, []int64{4}))
	image := openBytes(t, file)
	samples, err := image.ReadRect([]int64{0}, []int64{1})
	if err != nil {
		t.Fatalf("ReadRect: %v", err)
	}
	requirePhysical(t, samples[0].Physical, "-6")
}

func TestImageAccessorsReturnCopies(t *testing.T) {
	cards := requiredCards(8, 2)
	cards = append(cards, testCard{keyword: "BSCALE", value: "2"})
	file := fileBytes(t, cards, encodeSamples(t, 8, []int64{1, 2}))
	image := openBytes(t, file)

	shape := image.Shape()
	shape[0] = 99
	if image.Shape()[0] != 2 {
		t.Fatal("Shape did not return a copy")
	}
	header := image.Header()
	header.Cards[0].Value = "F"
	if image.Header().Cards[0].Value == "F" {
		t.Fatal("Header did not return a copy")
	}
	scale := image.BScale()
	scale.SetInt64(10)
	if image.BScale().Cmp(big.NewRat(2, 1)) != 0 {
		t.Fatal("BScale did not return a copy")
	}
}

func TestFixtureBuilderProducesExpectedLayout(t *testing.T) {
	file := fileBytes(t, requiredCards(16, 2), encodeSamples(t, 16, []int64{1, 2}))
	if len(file) != 5760 {
		t.Fatalf("fixture size = %d", len(file))
	}
	if !bytes.Equal(file[2880+4:], bytes.Repeat([]byte{0}, 2876)) {
		t.Fatal("fixture padding is not zero")
	}
	reader := bytes.NewReader(file)
	n, err := reader.ReadAt(make([]byte, 8), 2880)
	if err != nil || n != 8 || binary.BigEndian.Uint16(file[2880:2882]) != 1 {
		t.Fatalf("fixture data start n=%d err=%v", n, err)
	}
}
