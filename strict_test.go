package dataeng_test

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"testing"

	dataeng "example.org/dataeng/q0252"
)

func TestMalformedHeadersAreRejected(t *testing.T) {
	baseData := encodeSamples(t, 16, []int64{1, 2})

	tests := []struct {
		name  string
		cards []testCard
	}{
		{
			name: "duplicate keyword",
			cards: append(requiredCards(16, 2),
				testCard{keyword: "BITPIX", value: "16"}),
		},
		{
			name: "missing simple",
			cards: []testCard{
				{keyword: "BITPIX", value: "16"},
				{keyword: "NAXIS", value: "1"},
				{keyword: "NAXIS1", value: "2"},
			},
		},
		{
			name: "simple false",
			cards: []testCard{
				{keyword: "SIMPLE", value: "F"},
				{keyword: "BITPIX", value: "16"},
				{keyword: "NAXIS", value: "1"},
				{keyword: "NAXIS1", value: "2"},
			},
		},
		{
			name: "missing axis card",
			cards: []testCard{
				{keyword: "SIMPLE", value: "T"},
				{keyword: "BITPIX", value: "16"},
				{keyword: "NAXIS", value: "1"},
			},
		},
		{
			name: "extra axis card",
			cards: append(requiredCards(16, 2),
				testCard{keyword: "NAXIS2", value: "3"}),
		},
		{
			name: "noncanonical axis keyword",
			cards: []testCard{
				{keyword: "SIMPLE", value: "T"},
				{keyword: "BITPIX", value: "16"},
				{keyword: "NAXIS", value: "1"},
				{keyword: "NAXIS01", value: "2"},
			},
		},
		{
			name: "naxis too large",
			cards: []testCard{
				{keyword: "SIMPLE", value: "T"},
				{keyword: "BITPIX", value: "16"},
				{keyword: "NAXIS", value: "9"},
			},
		},
		{
			name: "exponent notation",
			cards: append(requiredCards(16, 2),
				testCard{keyword: "BZERO", value: "1E3"}),
		},
		{
			name: "string value",
			cards: append(requiredCards(16, 2),
				testCard{keyword: "TITLE", value: "'archive'"}),
		},
		{
			name: "blank outside raw range",
			cards: append(requiredCards(16, 2),
				testCard{keyword: "BLANK", value: "40000"}),
		},
		{
			name: "noninteger blank",
			cards: append(requiredCards(16, 2),
				testCard{keyword: "BLANK", value: "1.0"}),
		},
		{
			name: "negative axis length",
			cards: []testCard{
				{keyword: "SIMPLE", value: "T"},
				{keyword: "BITPIX", value: "16"},
				{keyword: "NAXIS", value: "1"},
				{keyword: "NAXIS1", value: "-1"},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			file := fileBytes(t, test.cards, baseData)
			_, err := dataeng.Open(bytes.NewReader(file), int64(len(file)))
			if !errors.Is(err, dataeng.ErrInvalidHeader) {
				t.Fatalf("error = %v, want ErrInvalidHeader", err)
			}
		})
	}
}

func TestBadEqualsAndEndPaddingAreRejected(t *testing.T) {
	validCards := requiredCards(16, 2)
	valid := fileBytes(t, validCards, encodeSamples(t, 16, []int64{1, 2}))

	badEquals := append([]byte(nil), valid...)
	badEquals[8] = ' '
	_, err := dataeng.Open(bytes.NewReader(badEquals), int64(len(badEquals)))
	if !errors.Is(err, dataeng.ErrInvalidHeader) {
		t.Fatalf("bad equals error = %v", err)
	}

	badEnd := append([]byte(nil), valid...)
	endCard := 80 * len(validCards)
	badEnd[endCard+80] = 0
	_, err = dataeng.Open(bytes.NewReader(badEnd), int64(len(badEnd)))
	if !errors.Is(err, dataeng.ErrInvalidPadding) {
		t.Fatalf("bad END padding error = %v", err)
	}
}

func TestLayoutViolationsAreRejected(t *testing.T) {
	valid := fileBytes(t, requiredCards(16, 2), encodeSamples(t, 16, []int64{1, 2}))

	truncatedData := append([]byte(nil), valid[:len(valid)-1]...)
	_, err := dataeng.Open(bytes.NewReader(truncatedData), int64(len(truncatedData)))
	if !errors.Is(err, dataeng.ErrTruncated) {
		t.Fatalf("truncated data error = %v", err)
	}

	truncatedHeader := append([]byte(nil), valid[:100]...)
	_, err = dataeng.Open(bytes.NewReader(truncatedHeader), 100)
	if !errors.Is(err, dataeng.ErrTruncated) {
		t.Fatalf("truncated header error = %v", err)
	}

	trailing := append(append([]byte(nil), valid...), 0)
	_, err = dataeng.Open(bytes.NewReader(trailing), int64(len(trailing)))
	if !errors.Is(err, dataeng.ErrTrailingData) {
		t.Fatalf("trailing data error = %v", err)
	}

	secondHDU := append(append([]byte(nil), valid...), headerBytes(t, requiredCards(8))...)
	_, err = dataeng.Open(bytes.NewReader(secondHDU), int64(len(secondHDU)))
	if !errors.Is(err, dataeng.ErrTrailingData) {
		t.Fatalf("second HDU error = %v", err)
	}

	badDataPadding := append([]byte(nil), valid...)
	badDataPadding[2884] = 1
	_, err = dataeng.Open(bytes.NewReader(badDataPadding), int64(len(badDataPadding)))
	if !errors.Is(err, dataeng.ErrInvalidPadding) {
		t.Fatalf("bad data padding error = %v", err)
	}

	noEnd := make([]byte, 2880)
	for i := 0; i < 36; i++ {
		copy(noEnd[i*80:], cardBytes(t, testCard{keyword: fmt.Sprintf("X%03d", i), value: fmt.Sprint(i)}))
	}
	_, err = dataeng.Open(bytes.NewReader(noEnd), int64(len(noEnd)))
	if !errors.Is(err, dataeng.ErrTruncated) {
		t.Fatalf("missing END error = %v", err)
	}
}

func TestHeaderAndOutputResourceLimits(t *testing.T) {
	var cards []testCard
	cards = append(cards, requiredCards(16, 40)...)
	for i := 0; i < 40; i++ {
		cards = append(cards, testCard{keyword: fmt.Sprintf("X%03d", i), value: fmt.Sprint(i)})
	}
	values := make([]int64, 40)
	file := fileBytes(t, cards, encodeSamples(t, 16, values))

	_, err := dataeng.Open(bytes.NewReader(file), int64(len(file)), dataeng.WithMaxHeaderCards(20))
	if !errors.Is(err, dataeng.ErrResourceLimit) {
		t.Fatalf("header limit error = %v", err)
	}

	image, err := dataeng.Open(bytes.NewReader(file), int64(len(file)), dataeng.WithMaxOutputPixels(39))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	samples, err := image.ReadRect([]int64{0}, []int64{40})
	if !errors.Is(err, dataeng.ErrResourceLimit) {
		t.Fatalf("output limit error = %v", err)
	}
	if samples != nil {
		t.Fatalf("resource limit returned %d partial samples", len(samples))
	}

	samples, err = image.ReadRect([]int64{0}, []int64{39})
	if err != nil || len(samples) != 39 {
		t.Fatalf("at-limit read: %d samples, error %v", len(samples), err)
	}
}

func TestReadRegionRejectsWholeRequest(t *testing.T) {
	file := fileBytes(t, requiredCards(16, 3, 2), encodeSamples(t, 16, []int64{1, 2, 3, 4, 5, 6}))
	image := openBytes(t, file)

	tests := []struct {
		name       string
		start, end []int64
	}{
		{name: "negative start", start: []int64{-1, 0}, end: []int64{2, 1}},
		{name: "past end", start: []int64{0, 0}, end: []int64{3, 3}},
		{name: "reversed", start: []int64{1, 0}, end: []int64{0, 1}},
		{name: "wrong dimensions", start: []int64{0}, end: []int64{1}},
		{name: "different lengths", start: []int64{0, 0}, end: []int64{1}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			samples, err := image.ReadRect(test.start, test.end)
			if !errors.Is(err, dataeng.ErrInvalidRegion) {
				t.Fatalf("error = %v", err)
			}
			if samples != nil {
				t.Fatalf("invalid region returned %d samples", len(samples))
			}
		})
	}
}

var errInjected = errors.New("injected reader failure")

type injectingReader struct {
	data       []byte
	failOffset int64
	armed      bool
	visible    int
}

func (r *injectingReader) ReadAt(p []byte, offset int64) (int, error) {
	if r.armed && offset <= r.failOffset && r.failOffset < offset+int64(len(p)) {
		return 0, errInjected
	}
	data := r.data
	if r.armed && r.visible > 0 {
		data = data[:r.visible]
	}
	if offset >= int64(len(data)) {
		return 0, io.EOF
	}
	n := copy(p, data[offset:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func TestDataReadFailureReturnsNoPartialSamples(t *testing.T) {
	file := fileBytes(t, requiredCards(16, 4), encodeSamples(t, 16, []int64{1, 2, 3, 4}))
	reader := &injectingReader{data: file, failOffset: 2880 + 2}
	image, err := dataeng.Open(reader, int64(len(file)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	reader.armed = true
	samples, err := image.ReadRect([]int64{0}, []int64{4})
	if !errors.Is(err, errInjected) {
		t.Fatalf("ReadRect error = %v", err)
	}
	if samples != nil {
		t.Fatalf("read failure returned %d partial samples", len(samples))
	}
}

func TestShortReaderIsReportedAsTruncated(t *testing.T) {
	file := fileBytes(t, requiredCards(16, 4), encodeSamples(t, 16, []int64{1, 2, 3, 4}))
	reader := &injectingReader{data: file, visible: 2882}
	image, err := dataeng.Open(reader, int64(len(file)))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	reader.armed = true
	samples, err := image.ReadRect([]int64{0}, []int64{4})
	if !errors.Is(err, dataeng.ErrTruncated) {
		t.Fatalf("ReadRect error = %v", err)
	}
	if samples != nil {
		t.Fatalf("short read returned %d samples", len(samples))
	}
}
