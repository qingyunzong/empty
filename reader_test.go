package dataeng_test

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"sync"
	"testing"

	dataeng "example.org/dataeng/q0164"
)

/***** counting fixtures *****/

type fixtureRead struct {
	offset int64
	length int
}

type fixtureReadAt struct {
	mu      sync.Mutex
	data    []byte
	calls   int
	reads   []fixtureRead
	failAt  int64
	failErr error
	short   bool
}

func newFixtureReadAt(data []byte) *fixtureReadAt {
	return &fixtureReadAt{data: data, failAt: -1}
}

func (f *fixtureReadAt) ReadAt(p []byte, off int64) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.reads = append(f.reads, fixtureRead{offset: off, length: len(p)})

	if off < 0 || off > int64(len(f.data)) {
		return 0, fmt.Errorf("fixture: offset %d outside file", off)
	}
	if f.failAt >= 0 && off == f.failAt {
		if f.short {
			n := len(p) / 2
			if n > len(f.data)-int(off) {
				n = len(f.data) - int(off)
			}
			copy(p[:n], f.data[off:int(off)+n])
			return n, io.ErrUnexpectedEOF
		}
		if f.failErr != nil {
			return 0, f.failErr
		}
		return 0, errors.New("fixture: injected read failure")
	}
	n := copy(p, f.data[off:])
	if n != len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (f *fixtureReadAt) snapshot() (int, []fixtureRead) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls, append([]fixtureRead(nil), f.reads...)
}

func (f *fixtureReadAt) reset() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = 0
	f.reads = nil
}

type fixtureDecoder struct {
	mu     sync.Mutex
	calls  int
	decode func([]byte) ([]byte, error)
}

func identityDecoder() *fixtureDecoder {
	return &fixtureDecoder{decode: func(data []byte) ([]byte, error) {
		return append([]byte(nil), data...), nil
	}}
}

func (d *fixtureDecoder) Decode(data []byte) ([]byte, error) {
	d.mu.Lock()
	d.calls++
	d.mu.Unlock()
	return d.decode(data)
}

func (d *fixtureDecoder) callCount() int {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.calls
}

/***** page/index builders *****/

type fixturePage struct {
	firstRow int64
	width    int
	data     []byte
	offset   int64
}

func newFixturePage(t *testing.T, firstRow int64, width int, data string) *fixturePage {
	t.Helper()
	if len(data)%width != 0 {
		t.Fatalf("page data %q is not a multiple of width %d", data, width)
	}
	return &fixturePage{firstRow: firstRow, width: width, data: []byte(data)}
}

func buildFixture(t *testing.T, width int, total int64, physicalOrder []*fixturePage, pageList []*fixturePage) (dataeng.Index, []byte) {
	t.Helper()
	var file bytes.Buffer
	for _, page := range physicalOrder {
		page.offset = int64(file.Len())
		file.Write(page.data)
	}

	index := dataeng.Index{TotalRows: total}
	for _, page := range pageList {
		digest := sha256.Sum256(page.data)
		index.Pages = append(index.Pages, dataeng.Page{
			Offset:        page.offset,
			CompressedLen: int64(len(page.data)),
			DecodedLen:    int64(len(page.data)),
			SHA256:        digest,
			FirstRow:      page.firstRow,
			RowCount:      int64(len(page.data) / width),
		})
	}
	return index, file.Bytes()
}

func mustReader(t *testing.T, src io.ReaderAt, fileSize int64, index dataeng.Index, decoder dataeng.Decoder, width int) *dataeng.Reader {
	t.Helper()
	reader, err := dataeng.NewReader(src, fileSize, index, decoder, width)
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	return reader
}

/***** tests *****/

func TestReadRowsSelectsOnlyIntersectingPages(t *testing.T) {
	const width = 4
	page0 := newFixturePage(t, 0, width, "0000"+"1111")
	page1 := newFixturePage(t, 2, width, "2222"+"3333")
	page2 := newFixturePage(t, 4, width, "4444"+"5555")

	// Physical layout is deliberately out of row order.
	index, file := buildFixture(t, width, 6, []*fixturePage{page2, page0, page1}, []*fixturePage{page0, page1, page2})
	src := newFixtureReadAt(file)
	decoder := identityDecoder()
	reader := mustReader(t, src, int64(len(file)), index, decoder, width)

	if calls, _ := src.snapshot(); calls != 0 {
		t.Fatalf("constructor performed %d reads", calls)
	}
	if decoder.callCount() != 0 {
		t.Fatalf("constructor performed %d decodes", decoder.callCount())
	}
	if reader.TotalRows() != 6 || reader.RowWidth() != width || reader.PageCount() != 3 {
		t.Fatalf("reader metadata = rows:%d width:%d pages:%d", reader.TotalRows(), reader.RowWidth(), reader.PageCount())
	}

	got, err := reader.ReadRows(1, 5)
	if err != nil {
		t.Fatalf("ReadRows: %v", err)
	}
	if want := "1111" + "2222" + "3333" + "4444"; string(got) != want {
		t.Fatalf("rows = %q, want %q", got, want)
	}

	calls, reads := src.snapshot()
	if calls != 3 {
		t.Fatalf("ReadRows performed %d reads, want 3", calls)
	}
	wantReads := []fixtureRead{
		{offset: page0.offset, length: len(page0.data)},
		{offset: page1.offset, length: len(page1.data)},
		{offset: page2.offset, length: len(page2.data)},
	}
	if fmt.Sprint(reads) != fmt.Sprint(wantReads) {
		t.Fatalf("reads = %v, want %v", reads, wantReads)
	}
	if decoder.callCount() != 3 {
		t.Fatalf("decodes = %d, want 3", decoder.callCount())
	}

	src.reset()
	decoder.calls = 0
	got, err = reader.ReadRows(0, 2)
	if err != nil {
		t.Fatalf("ReadRows subset: %v", err)
	}
	if string(got) != "0000"+"1111" {
		t.Fatalf("subset rows = %q", got)
	}
	calls, reads = src.snapshot()
	if calls != 1 || reads[0].offset != page0.offset {
		t.Fatalf("subset reads = %v, want only page0 at %d", reads, page0.offset)
	}
	if decoder.callCount() != 1 {
		t.Fatalf("subset decodes = %d, want 1", decoder.callCount())
	}
}

func TestReadRowsRejectsInvalidQueriesWithoutReads(t *testing.T) {
	const width = 2
	page := newFixturePage(t, 0, width, "aabbcc")
	index, file := buildFixture(t, width, 3, []*fixturePage{page}, []*fixturePage{page})
	src := newFixtureReadAt(file)
	reader := mustReader(t, src, int64(len(file)), index, identityDecoder(), width)

	cases := []struct {
		name       string
		start, end int64
	}{
		{name: "negative start", start: -1, end: 1},
		{name: "reversed", start: 2, end: 1},
		{name: "past end", start: 2, end: 4},
		{name: "past total", start: 4, end: 5},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := reader.ReadRows(tc.start, tc.end); !errors.Is(err, dataeng.ErrInvalidQuery) {
				t.Fatalf("ReadRows(%d,%d) error = %v, want ErrInvalidQuery", tc.start, tc.end, err)
			}
			if calls, _ := src.snapshot(); calls != 0 {
				t.Fatalf("invalid query performed %d reads", calls)
			}
		})
	}
}

func TestEmptyQueryDoesNotReadOrDecode(t *testing.T) {
	const width = 2
	page := newFixturePage(t, 0, width, "aabb")
	index, file := buildFixture(t, width, 2, []*fixturePage{page}, []*fixturePage{page})
	src := newFixtureReadAt(file)
	decoder := identityDecoder()
	reader := mustReader(t, src, int64(len(file)), index, decoder, width)

	for _, point := range []int64{0, 1, 2} {
		rows, err := reader.ReadRows(point, point)
		if err != nil {
			t.Fatalf("empty query at %d: %v", point, err)
		}
		if len(rows) != 0 {
			t.Fatalf("empty query at %d returned %d bytes", point, len(rows))
		}
	}
	if calls, _ := src.snapshot(); calls != 0 {
		t.Fatalf("empty queries performed %d reads", calls)
	}
	if decoder.callCount() != 0 {
		t.Fatalf("empty queries performed %d decodes", decoder.callCount())
	}

	emptyIndex := dataeng.Index{TotalRows: 0}
	emptyReader := mustReader(t, newFixtureReadAt(nil), 0, emptyIndex, identityDecoder(), width)
	if rows, err := emptyReader.ReadRows(0, 0); err != nil || len(rows) != 0 {
		t.Fatalf("empty file query = (%d bytes, %v)", len(rows), err)
	}
	if _, err := emptyReader.ReadRows(0, 1); !errors.Is(err, dataeng.ErrInvalidQuery) {
		t.Fatalf("row query on empty file error = %v, want ErrInvalidQuery", err)
	}
}

func TestInvalidIndexNeverCallsReadAt(t *testing.T) {
	const width = 4
	baseData := "00001111222233334444"
	digest := sha256.Sum256([]byte(baseData))

	validPage := func(firstRow int64, offset int64, rows int64, digest [sha256.Size]byte) dataeng.Page {
		return dataeng.Page{
			Offset:        offset,
			CompressedLen: rows * width,
			DecodedLen:    rows * width,
			SHA256:        digest,
			FirstRow:      firstRow,
			RowCount:      rows,
		}
	}

	file := []byte(baseData)
	tests := []struct {
		name  string
		index dataeng.Index
		width int
		file  []byte
	}{
		{
			name: "row gap",
			index: dataeng.Index{TotalRows: 6, Pages: []dataeng.Page{
				validPage(0, 0, 2, digest),
				validPage(3, 8, 3, digest),
			}},
			width: width,
			file:  file,
		},
		{
			name: "row overlap",
			index: dataeng.Index{TotalRows: 4, Pages: []dataeng.Page{
				validPage(0, 0, 3, digest),
				validPage(2, 12, 2, digest),
			}},
			width: width,
			file:  file,
		},
		{
			name: "total mismatch",
			index: dataeng.Index{TotalRows: 5, Pages: []dataeng.Page{
				validPage(0, 0, 2, digest),
				validPage(2, 8, 2, digest),
			}},
			width: width,
			file:  file,
		},
		{
			name: "first row not zero",
			index: dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{
				validPage(1, 0, 2, digest),
			}},
			width: width,
			file:  file,
		},
		{
			name: "physical overlap",
			index: dataeng.Index{TotalRows: 4, Pages: []dataeng.Page{
				validPage(0, 0, 2, digest),
				validPage(2, 6, 2, digest),
			}},
			width: width,
			file:  file,
		},
		{
			name: "physical range outside file",
			index: dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{
				validPage(0, int64(len(file))-2, 2, digest),
			}},
			width: width,
			file:  file,
		},
		{
			name: "decoded length not rows times width",
			index: dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{
				{Offset: 0, CompressedLen: 8, DecodedLen: 7, SHA256: digest, FirstRow: 0, RowCount: 2},
			}},
			width: width,
			file:  file,
		},
		{
			name: "negative offset",
			index: dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{
				{Offset: -1, CompressedLen: 8, DecodedLen: 8, SHA256: digest, FirstRow: 0, RowCount: 2},
			}},
			width: width,
			file:  file,
		},
		{
			name: "negative decoded length",
			index: dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{
				{Offset: 0, CompressedLen: 8, DecodedLen: -8, SHA256: digest, FirstRow: 0, RowCount: 2},
			}},
			width: width,
			file:  file,
		},
		{
			name: "zero row page",
			index: dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{
				{Offset: 0, CompressedLen: 8, DecodedLen: 0, SHA256: digest, FirstRow: 0, RowCount: 0},
			}},
			width: width,
			file:  file,
		},
		{
			name:  "pages but zero total",
			index: dataeng.Index{TotalRows: 0, Pages: []dataeng.Page{validPage(0, 0, 2, digest)}},
			width: width,
			file:  file,
		},
		{
			name:  "no pages but positive total",
			index: dataeng.Index{TotalRows: 2},
			width: width,
			file:  file,
		},
		{
			name:  "zero width",
			index: dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{validPage(0, 0, 2, digest)}},
			width: 0,
			file:  file,
		},
		{
			name:  "negative width",
			index: dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{validPage(0, 0, 2, digest)}},
			width: -width,
			file:  file,
		},
		{
			name: "row range overflow",
			index: dataeng.Index{TotalRows: 4, Pages: []dataeng.Page{
				{Offset: 0, CompressedLen: 8, DecodedLen: 8, SHA256: digest, FirstRow: 1<<62 + 1, RowCount: 2},
			}},
			width: width,
			file:  file,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			src := newFixtureReadAt(tc.file)
			_, err := dataeng.NewReader(src, int64(len(tc.file)), tc.index, identityDecoder(), tc.width)
			if !errors.Is(err, dataeng.ErrInvalidIndex) {
				t.Fatalf("NewReader error = %v, want ErrInvalidIndex", err)
			}
			calls, reads := src.snapshot()
			if calls != 0 {
				t.Fatalf("invalid index performed %d reads: %v", calls, reads)
			}
		})
	}

	src := newFixtureReadAt(file)
	if _, err := dataeng.NewReader(src, int64(len(file)), dataeng.Index{TotalRows: 2}, nil, width); !errors.Is(err, dataeng.ErrInvalidIndex) {
		t.Fatalf("nil decoder error = %v, want ErrInvalidIndex", err)
	}
	if calls, _ := src.snapshot(); calls != 0 {
		t.Fatalf("nil decoder performed %d reads", calls)
	}
}

func TestCorruptedPagesAreDetected(t *testing.T) {
	const width = 4
	page0 := newFixturePage(t, 0, width, "00001111")
	page1 := newFixturePage(t, 2, width, "22223333")
	index, file := buildFixture(t, width, 4, []*fixturePage{page0, page1}, []*fixturePage{page0, page1})
	index.Pages[1].SHA256 = sha256.Sum256([]byte("not the page"))

	src := newFixtureReadAt(file)
	reader := mustReader(t, src, int64(len(file)), index, identityDecoder(), width)

	if _, err := reader.ReadRows(0, 2); err != nil {
		t.Fatalf("uncorrupted page read: %v", err)
	}
	calls, reads := src.snapshot()
	if calls != 1 || reads[0].offset != page0.offset {
		t.Fatalf("selective read = %v, want page0 only", reads)
	}

	src.reset()
	if _, err := reader.ReadRows(2, 4); !errors.Is(err, dataeng.ErrDigestMismatch) {
		t.Fatalf("corrupt page error = %v, want ErrDigestMismatch", err)
	}
	if calls, _ := src.snapshot(); calls != 1 {
		t.Fatalf("corrupt page read count = %d, want 1", calls)
	}
}

func TestDecodedLengthAndDecoderFailures(t *testing.T) {
	const width = 2
	page := newFixturePage(t, 0, width, "aabb")
	index, file := buildFixture(t, width, 2, []*fixturePage{page}, []*fixturePage{page})

	t.Run("wrong decoded length", func(t *testing.T) {
		src := newFixtureReadAt(file)
		decoder := &fixtureDecoder{decode: func(data []byte) ([]byte, error) {
			return append(data, 0), nil
		}}
		reader := mustReader(t, src, int64(len(file)), index, decoder, width)
		if _, err := reader.ReadRows(0, 2); !errors.Is(err, dataeng.ErrDecodedLength) {
			t.Fatalf("error = %v, want ErrDecodedLength", err)
		}
	})

	t.Run("decoder error", func(t *testing.T) {
		wantErr := errors.New("decoder exploded")
		src := newFixtureReadAt(file)
		reader := mustReader(t, src, int64(len(file)), index, &fixtureDecoder{decode: func([]byte) ([]byte, error) {
			return nil, wantErr
		}}, width)
		_, err := reader.ReadRows(0, 2)
		if !errors.Is(err, dataeng.ErrDecode) || !errors.Is(err, wantErr) {
			t.Fatalf("error = %v, want ErrDecode wrapping %v", err, wantErr)
		}
	})

	t.Run("short read", func(t *testing.T) {
		src := newFixtureReadAt(file)
		src.failAt = page.offset
		src.short = true
		reader := mustReader(t, src, int64(len(file)), index, identityDecoder(), width)
		if _, err := reader.ReadRows(0, 2); !errors.Is(err, dataeng.ErrShortRead) {
			t.Fatalf("error = %v, want ErrShortRead", err)
		}
	})

	t.Run("read error", func(t *testing.T) {
		wantErr := errors.New("io exploded")
		src := newFixtureReadAt(file)
		src.failAt = page.offset
		src.failErr = wantErr
		reader := mustReader(t, src, int64(len(file)), index, identityDecoder(), width)
		_, err := reader.ReadRows(0, 2)
		// A zero-byte read is reported as a short read before ReadAt's error is
		// considered, but the original cause remains in the chain.
		if !errors.Is(err, dataeng.ErrShortRead) || !errors.Is(err, wantErr) {
			t.Fatalf("error = %v, want ErrShortRead wrapping %v", err, wantErr)
		}
	})
}

func TestReadWithProvenanceReturnsExactSourceRanges(t *testing.T) {
	const width = 4
	page0 := newFixturePage(t, 0, width, "00001111")
	page1 := newFixturePage(t, 2, width, "22223333")
	page2 := newFixturePage(t, 4, width, "44445555")
	index, file := buildFixture(t, width, 6, []*fixturePage{page2, page0, page1}, []*fixturePage{page0, page1, page2})

	reader := mustReader(t, newFixtureReadAt(file), int64(len(file)), index, identityDecoder(), width)
	result, err := reader.ReadWithProvenance(1, 5)
	if err != nil {
		t.Fatalf("ReadWithProvenance: %v", err)
	}
	if want := "1111222233334444"; string(result.Rows) != want {
		t.Fatalf("rows = %q, want %q", result.Rows, want)
	}
	wantSources := []dataeng.Source{
		{Page: 0, FirstRow: 0, RowOffset: 1, RowCount: 1, ByteOffset: 4, ByteLength: 4},
		{Page: 1, FirstRow: 2, RowOffset: 0, RowCount: 2, ByteOffset: 0, ByteLength: 8},
		{Page: 2, FirstRow: 4, RowOffset: 0, RowCount: 1, ByteOffset: 0, ByteLength: 4},
	}
	if fmt.Sprint(result.Sources) != fmt.Sprint(wantSources) {
		t.Fatalf("sources = %v, want %v", result.Sources, wantSources)
	}
}

func TestAliasFieldsAndPlainFuncDecoder(t *testing.T) {
	const width = 2
	data := []byte("aabbcc")
	digest := sha256.Sum256(data)
	index := dataeng.Index{
		Rows: 3,
		Entries: []dataeng.Page{
			{
				FileOffset:     0,
				CompressedSize: int64(len(data)),
				DecodedSize:    int64(len(data)),
				Digest:         digest,
				StartRow:       0,
				NumRows:        3,
			},
		},
	}
	src := newFixtureReadAt(data)
	reader, err := dataeng.NewReader(src, int64(len(data)), index, func(encoded []byte) ([]byte, error) {
		return append([]byte(nil), encoded...), nil
	}, width)
	if err != nil {
		t.Fatalf("NewReader with aliases: %v", err)
	}
	rows, err := reader.ReadRows(1, 3)
	if err != nil {
		t.Fatalf("ReadRows: %v", err)
	}
	if string(rows) != "bbcc" {
		t.Fatalf("rows = %q, want %q", rows, "bbcc")
	}
}

func TestDecodersAcceptedByConstructor(t *testing.T) {
	const width = 2
	data := []byte("aabb")
	digest := sha256.Sum256(data)
	index := dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{{
		Offset: 0, CompressedLen: 4, DecodedLen: 4, SHA256: digest, FirstRow: 0, RowCount: 2,
	}}}

	cases := []struct {
		name    string
		decoder any
	}{
		{name: "Decoder interface", decoder: identityDecoder()},
		{name: "DecoderFunc", decoder: dataeng.DecoderFunc(func(data []byte) ([]byte, error) {
			return append([]byte(nil), data...), nil
		})},
		{name: "plain func", decoder: func(data []byte) ([]byte, error) {
			return append([]byte(nil), data...), nil
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reader, err := dataeng.NewReader(newFixtureReadAt(data), int64(len(data)), index, tc.decoder, width)
			if err != nil {
				t.Fatalf("NewReader: %v", err)
			}
			rows, err := reader.ReadRows(0, 2)
			if err != nil || string(rows) != "aabb" {
				t.Fatalf("rows = %q, err = %v", rows, err)
			}
		})
	}
}

func TestUnsortedPageListAndConstructorOrders(t *testing.T) {
	const width = 2
	page0 := newFixturePage(t, 0, width, "aabb")
	page1 := newFixturePage(t, 2, width, "ccdd")
	page2 := newFixturePage(t, 4, width, "eeff")

	// Both the page list and the physical order may be arbitrary.
	index, file := buildFixture(t, width, 6, []*fixturePage{page1, page2, page0}, []*fixturePage{page2, page0, page1})
	decoder := func(data []byte) ([]byte, error) {
		return append([]byte(nil), data...), nil
	}

	calls := []struct {
		name  string
		build func() (*dataeng.Reader, error)
	}{
		{
			name: "canonical order",
			build: func() (*dataeng.Reader, error) {
				return dataeng.NewReader(newFixtureReadAt(file), int64(len(file)), index, decoder, width)
			},
		},
		{
			name: "index before size",
			build: func() (*dataeng.Reader, error) {
				return dataeng.NewReader(newFixtureReadAt(file), index, int64(len(file)), decoder, width)
			},
		},
		{
			name: "width before decoder",
			build: func() (*dataeng.Reader, error) {
				return dataeng.NewReader(newFixtureReadAt(file), int64(len(file)), index, width, decoder)
			},
		},
		{
			name: "page slice with explicit total",
			build: func() (*dataeng.Reader, error) {
				return dataeng.NewReader(newFixtureReadAt(file), int64(len(file)), int64(6), index.Pages, decoder, width)
			},
		},
	}
	for _, tc := range calls {
		t.Run(tc.name, func(t *testing.T) {
			reader, err := tc.build()
			if err != nil {
				t.Fatalf("NewReader: %v", err)
			}
			rows, err := reader.ReadRows(1, 5)
			if err != nil {
				t.Fatalf("ReadRows: %v", err)
			}
			if string(rows) != "bbccddee" {
				t.Fatalf("rows = %q, want %q", rows, "bbccddee")
			}
		})
	}
}

func TestReadAndRowsUseCountSemantics(t *testing.T) {
	const width = 2
	page := newFixturePage(t, 0, width, "aabbccdd")
	index, file := buildFixture(t, width, 4, []*fixturePage{page}, []*fixturePage{page})
	reader := mustReader(t, newFixtureReadAt(file), int64(len(file)), index, identityDecoder(), width)

	rows, err := reader.Read(1, 2)
	if err != nil || string(rows) != "bbcc" {
		t.Fatalf("Read = %q, %v", rows, err)
	}
	rowSlices, err := reader.Rows(2, 2)
	if err != nil {
		t.Fatalf("Rows: %v", err)
	}
	if len(rowSlices) != 2 || string(rowSlices[0]) != "cc" || string(rowSlices[1]) != "dd" {
		t.Fatalf("row slices = %q", rowSlices)
	}
	if _, err := reader.Read(3, 2); !errors.Is(err, dataeng.ErrInvalidQuery) {
		t.Fatalf("out-of-bounds Read error = %v, want ErrInvalidQuery", err)
	}

	start, end := 1, int64(3)
	if rows, err := reader.ReadRows(start, end); err != nil || string(rows) != "bbcc" {
		t.Fatalf("mixed integer query = %q, %v", rows, err)
	}
	if _, err := reader.ReadRows(1.5, 2); !errors.Is(err, dataeng.ErrInvalidQuery) {
		t.Fatalf("non-integer query error = %v, want ErrInvalidQuery", err)
	}
}

func TestWrongWidthCannotBeMaskedByConstructorOrder(t *testing.T) {
	const actualWidth = 4
	data := []byte("00001111")
	digest := sha256.Sum256(data)
	index := dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{{
		Offset: 0, CompressedLen: int64(len(data)), DecodedLen: int64(len(data)), SHA256: digest, FirstRow: 0, RowCount: 2,
	}}}

	// The file is exactly one row wide in bytes, but W is still a caller
	// parameter and must not be replaced by the file size during validation.
	src := newFixtureReadAt(data)
	if _, err := dataeng.NewReader(src, int64(len(data)), index, identityDecoder(), 10); !errors.Is(err, dataeng.ErrInvalidIndex) {
		t.Fatalf("wrong width error = %v, want ErrInvalidIndex", err)
	}
	if calls, _ := src.snapshot(); calls != 0 {
		t.Fatalf("wrong width performed %d reads", calls)
	}
	if _, err := dataeng.NewReader(src, int64(actualWidth), index, identityDecoder(), 10); !errors.Is(err, dataeng.ErrInvalidIndex) {
		t.Fatalf("small file error = %v, want ErrInvalidIndex", err)
	}
	if calls, _ := src.snapshot(); calls != 0 {
		t.Fatalf("small file performed %d reads", calls)
	}

	pageData := []byte("0000111122223333")
	pageDigest := sha256.Sum256(pageData)
	pages := []dataeng.Page{{
		Offset: 0, CompressedLen: int64(len(pageData)), DecodedLen: int64(len(pageData)), SHA256: pageDigest, FirstRow: 0, RowCount: 4,
	}}
	src = newFixtureReadAt(pageData)
	if _, err := dataeng.NewReader(src, int64(len(pageData)), int64(5), pages, identityDecoder(), actualWidth); !errors.Is(err, dataeng.ErrInvalidIndex) {
		t.Fatalf("page-slice total mismatch error = %v, want ErrInvalidIndex", err)
	}
	if calls, _ := src.snapshot(); calls != 0 {
		t.Fatalf("page-slice total mismatch performed %d reads", calls)
	}
}

func TestRowRangeAliases(t *testing.T) {
	const width = 2
	data := []byte("aabb")
	digest := sha256.Sum256(data)
	index := dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{{
		Offset:        0,
		CompressedLen: int64(len(data)),
		DecodedLen:    int64(len(data)),
		SHA256:        digest,
		RowRange:      [2]int64{0, 2},
	}}}
	reader := mustReader(t, newFixtureReadAt(data), int64(len(data)), index, identityDecoder(), width)
	rows, err := reader.ReadRows(1, 2)
	if err != nil || string(rows) != "bb" {
		t.Fatalf("rows = %q, err = %v", rows, err)
	}
}

type namedReadAt func([]byte, int64) (int, error)
type namedDecoder func([]byte) ([]byte, error)

func TestNamedFunctionAdaptersAndConstructors(t *testing.T) {
	const width = 2
	data := []byte("aabb")
	digest := sha256.Sum256(data)
	index := dataeng.Index{TotalRows: 2, Pages: []dataeng.Page{{
		Offset: 0, CompressedLen: int64(len(data)), DecodedLen: int64(len(data)), SHA256: digest, FirstRow: 0, RowCount: 2,
	}}}

	file := newFixtureReadAt(data)
	var src namedReadAt = func(p []byte, off int64) (int, error) {
		return file.ReadAt(p, off)
	}
	decoder := namedDecoder(func(encoded []byte) ([]byte, error) {
		return append([]byte(nil), encoded...), nil
	})

	constructors := []struct {
		name string
		new  func() (*dataeng.Reader, error)
	}{
		{name: "NewReader", new: func() (*dataeng.Reader, error) {
			return dataeng.NewReader(src, int64(len(data)), index, decoder, width)
		}},
		{name: "Open", new: func() (*dataeng.Reader, error) {
			return dataeng.Open(src, int64(len(data)), index, decoder, width)
		}},
		{name: "New", new: func() (*dataeng.Reader, error) {
			return dataeng.New(src, int64(len(data)), index, decoder, width)
		}},
		{name: "OpenReader", new: func() (*dataeng.Reader, error) {
			return dataeng.OpenReader(src, int64(len(data)), index, decoder, width)
		}},
		{name: "NewIndexedReader", new: func() (*dataeng.Reader, error) {
			return dataeng.NewIndexedReader(src, int64(len(data)), index, decoder, width)
		}},
		{name: "byte source", new: func() (*dataeng.Reader, error) {
			return dataeng.NewReader(data, int64(len(data)), index, decoder, width)
		}},
	}
	for _, tc := range constructors {
		t.Run(tc.name, func(t *testing.T) {
			reader, err := tc.new()
			if err != nil {
				t.Fatalf("constructor: %v", err)
			}
			rows, err := reader.ReadRows(0, 2)
			if err != nil || string(rows) != "aabb" {
				t.Fatalf("rows = %q, err = %v", rows, err)
			}
		})
	}
}
