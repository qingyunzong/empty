package dataeng_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"testing"

	"example.org/dataeng/q0323"
	"example.org/dataeng/q0323/fixture"
)

const (
	testPageSize      = 512
	testReservedBytes = 32
	testUsable        = testPageSize - testReservedBytes
)

type byteInterval struct {
	start int64
	end   int64
}

type request struct {
	offset int64
	length int
}

type auditReader struct {
	file      []byte
	forbidden []byteInterval
	requests  []request
}

func (r *auditReader) ReadAt(p []byte, offset int64) (int, error) {
	r.requests = append(r.requests, request{offset: offset, length: len(p)})
	for _, forbidden := range r.forbidden {
		if offset < forbidden.end && offset+int64(len(p)) > forbidden.start {
			return 0, fmt.Errorf("forbidden read [%d,%d) overlaps [%d,%d)",
				offset, offset+int64(len(p)), forbidden.start, forbidden.end)
		}
	}
	if offset < 0 || offset >= int64(len(r.file)) {
		return 0, io.EOF
	}
	n := copy(p, r.file[offset:])
	if n != len(p) {
		return n, io.EOF
	}
	return n, nil
}

func testLayout(offset int) fixture.Layout {
	return fixture.Layout{
		PageSize:      testPageSize,
		ReservedBytes: testReservedBytes,
		CellPage:      1,
		CellOffset:    offset,
	}
}

func generousConfig(cell *fixture.Cell) dataeng.Config {
	return cell.Config(1<<20, 1<<20, 1<<30)
}

func patterned(n int) []byte {
	data := make([]byte, n)
	for i := range data {
		data[i] = byte((i*31 + 7) % 251)
	}
	return data
}

func exactBlobPayload(t *testing.T, target int) *fixture.BuiltPayload {
	t.Helper()
	length := target - 3
	if length < 0 {
		t.Fatalf("target %d is too small", target)
	}
	for attempt := 0; attempt < 12; attempt++ {
		payload, err := fixture.BuildPayload([]fixture.Column{
			fixture.BlobColumn(patterned(length)),
		})
		if err != nil {
			t.Fatalf("BuildPayload: %v", err)
		}
		delta := target - len(payload.Bytes)
		if delta == 0 {
			return payload
		}
		length += delta
	}
	t.Fatalf("could not converge payload length %d", target)
	return nil
}

func exactPrefixedPayload(t *testing.T, prefix []fixture.Column, target int) *fixture.BuiltPayload {
	t.Helper()
	length := target - len(prefix) - 3
	if length < 0 {
		t.Fatalf("target %d is too small for prefix", target)
	}
	for attempt := 0; attempt < 16; attempt++ {
		columns := append([]fixture.Column(nil), prefix...)
		columns = append(columns, fixture.BlobColumn(patterned(length)))
		payload, err := fixture.BuildPayload(columns)
		if err != nil {
			t.Fatalf("BuildPayload: %v", err)
		}
		delta := target - len(payload.Bytes)
		if delta == 0 {
			return payload
		}
		length += delta
	}
	t.Fatalf("could not converge prefixed payload length %d", target)
	return nil
}

func mustCell(t *testing.T, layout fixture.Layout, rowID int64, payload []byte, opts fixture.Options) *fixture.Cell {
	t.Helper()
	cell, err := fixture.BuildCell(layout, rowID, payload, opts)
	if err != nil {
		t.Fatalf("BuildCell: %v", err)
	}
	return cell
}

func mustProject(t *testing.T, reader io.ReaderAt, config dataeng.Config, cell *fixture.Cell, columns []int) *dataeng.Result {
	t.Helper()
	result, err := dataeng.Project(reader, config, cell.Ref(), columns)
	if err != nil {
		t.Fatalf("Project: %v", err)
	}
	return result
}

func assertReadMatches(t *testing.T, reader *auditReader, result *dataeng.Result) {
	t.Helper()
	if len(reader.requests) != len(result.Reads) {
		t.Fatalf("ReaderAt requests %d, recorded reads %d", len(reader.requests), len(result.Reads))
	}
	for i := range reader.requests {
		if reader.requests[i].offset != result.Reads[i].FileOffset ||
			reader.requests[i].length != result.Reads[i].Length {
			t.Fatalf("request %d = [%d,%d), recorded [%d,%d)",
				i, reader.requests[i].offset, reader.requests[i].length,
				result.Reads[i].FileOffset, result.Reads[i].Length)
		}
	}
}

func logicalIntervals(cell *fixture.Cell, start, length uint64) []byteInterval {
	if length == 0 {
		return nil
	}
	usable := uint64(cell.PageSize - cell.ReservedBytes)
	local := cell.LocalLength
	prefix := uint64(cell.CellLength) - local
	if cell.FirstOverflowPage != 0 {
		prefix -= 4
	}
	cellPayloadStart := cell.CellStart() + int64(prefix)
	end := start + length
	var intervals []byteInterval

	localEnd := local
	if localEnd > end {
		localEnd = end
	}
	if start < local {
		localStart := start
		intervals = append(intervals, byteInterval{
			start: cellPayloadStart + int64(localStart),
			end:   cellPayloadStart + int64(localEnd),
		})
	}

	capacity := usable - 4
	logical := local
	for _, page := range cell.OverflowPages {
		spanEnd := logical + capacity
		if spanEnd > cell.PayloadLength {
			spanEnd = cell.PayloadLength
		}
		from := start
		if from < logical {
			from = logical
		}
		to := end
		if to > spanEnd {
			to = spanEnd
		}
		if from < to {
			pageStart := int64(page-1) * int64(cell.PageSize)
			intervals = append(intervals, byteInterval{
				start: pageStart + 4 + int64(from-logical),
				end:   pageStart + 4 + int64(to-logical),
			})
		}
		logical = spanEnd
	}
	return intervals
}

func reservedIntervals(cell *fixture.Cell) []byteInterval {
	var intervals []byteInterval
	for page := uint64(1); page <= cell.TotalPages; page++ {
		pageStart := int64(page-1) * int64(cell.PageSize)
		intervals = append(intervals, byteInterval{
			start: pageStart + int64(cell.PageSize-cell.ReservedBytes),
			end:   pageStart + int64(cell.PageSize),
		})
	}
	return intervals
}

func unusedOverflowIntervals(cell *fixture.Cell) []byteInterval {
	usable := uint64(cell.PageSize - cell.ReservedBytes)
	capacity := usable - 4
	logical := cell.LocalLength
	var intervals []byteInterval
	for _, page := range cell.OverflowPages {
		used := capacity
		if remaining := cell.PayloadLength - logical; remaining < used {
			used = remaining
		}
		pageStart := int64(page-1) * int64(cell.PageSize)
		intervals = append(intervals, byteInterval{
			start: pageStart + 4 + int64(used),
			end:   pageStart + int64(usable),
		})
		logical += used
	}
	return intervals
}

func TestPayloadBoundaryAndKThresholds(t *testing.T) {
	cases := []struct {
		name           string
		payloadLength  int
		wantLocal      uint64
		wantOverflow   bool
		minOverflowLen int
	}{
		{"below", testUsable - 36, testUsable - 36, false, 0},
		{"exact-threshold", testUsable - 35, testUsable - 35, false, 0},
		{"one-over-threshold", testUsable - 34, 35, true, 1},
		{"k-at-threshold", 921, 445, true, 1},
		{"k-just-over-threshold", 922, 35, true, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			payload := exactBlobPayload(t, tc.payloadLength)
			if len(payload.Bytes) != tc.payloadLength {
				t.Fatalf("payload length %d, want %d", len(payload.Bytes), tc.payloadLength)
			}
			cell := mustCell(t, testLayout(0), 7, payload.Bytes, fixture.Options{})
			if cell.LocalLength != tc.wantLocal {
				t.Fatalf("local length %d, want %d", cell.LocalLength, tc.wantLocal)
			}
			if (cell.FirstOverflowPage != 0) != tc.wantOverflow {
				t.Fatalf("overflow=%t, want %t", cell.FirstOverflowPage != 0, tc.wantOverflow)
			}
			if len(cell.OverflowPages) < tc.minOverflowLen {
				t.Fatalf("overflow pages %d, want at least %d", len(cell.OverflowPages), tc.minOverflowLen)
			}

			reader := &auditReader{file: cell.File}
			result := mustProject(t, reader, generousConfig(cell), cell, []int{0})
			if result.LocalLength != tc.wantLocal {
				t.Fatalf("result local length %d, want %d", result.LocalLength, tc.wantLocal)
			}
			if len(result.Columns) != 1 || result.Columns[0].Kind != dataeng.ValueBlob {
				t.Fatalf("unexpected projected value: %+v", result.Columns)
			}
			want := payload.Bytes[payload.HeaderSize:]
			if !bytes.Equal(result.Columns[0].Blob, want) {
				t.Fatalf("projected blob does not match payload reference")
			}
			assertReadMatches(t, reader, result)
		})
	}
}

func TestNegativeRowIDNineByteVarint(t *testing.T) {
	for _, rowID := range []int64{-1, -2, -42, -1 << 40} {
		payload := exactBlobPayload(t, 20)
		cell := mustCell(t, testLayout(20), rowID, payload.Bytes, fixture.Options{RowIDVarintWidth: 9})
		encoded, err := fixture.EncodeVarint(uint64(rowID), 9)
		if err != nil {
			t.Fatalf("encode rowid: %v", err)
		}
		if len(encoded) != 9 {
			t.Fatalf("rowid encoding has %d bytes, want 9", len(encoded))
		}
		reader := &auditReader{file: cell.File}
		result := mustProject(t, reader, generousConfig(cell), cell, []int{0})
		if result.RowID != rowID {
			t.Fatalf("rowid %d, want %d", result.RowID, rowID)
		}
	}
}

func TestNonMinimalVarintsAccepted(t *testing.T) {
	payload := exactBlobPayload(t, 30)
	cell := mustCell(t, testLayout(20), 1, payload.Bytes, fixture.Options{
		PayloadVarintWidth: 9,
		RowIDVarintWidth:   9,
	})
	reader := &auditReader{file: cell.File}
	result := mustProject(t, reader, generousConfig(cell), cell, []int{0})
	if result.RowID != 1 {
		t.Fatalf("rowid %d, want 1", result.RowID)
	}
	if !bytes.Equal(result.Columns[0].Blob, payload.Bytes[payload.HeaderSize:]) {
		t.Fatalf("non-minimal varints changed the projected value")
	}
}

func TestHugeDeclaredPayloadRejectedBeforeChainRead(t *testing.T) {
	const declared = uint64(1)<<48 + 123
	cell, err := fixture.BuildDeclaredCell(
		testLayout(0), 1, declared, 2,
		fixture.Options{TotalPages: 2, ReservedFill: 0x7e},
	)
	if err != nil {
		t.Fatalf("BuildDeclaredCell: %v", err)
	}
	reader := &auditReader{file: cell.File}
	config := cell.Config(1<<20, 1, 1<<20)
	result, err := dataeng.Project(reader, config, cell.Ref(), []int{})
	if result != nil {
		t.Fatalf("huge payload returned a partial result")
	}
	if !errors.Is(err, dataeng.ErrBudgetExceeded) {
		t.Fatalf("error = %v, want ErrBudgetExceeded", err)
	}
	for _, request := range reader.requests {
		if request.offset >= int64(testPageSize) {
			t.Fatalf("read page after budget rejection: [%d,%d)", request.offset, request.offset+int64(request.length))
		}
	}
}

func TestHeaderCrossesFirstOverflowPage(t *testing.T) {
	prefix := make([]fixture.Column, 80)
	for i := range prefix {
		prefix[i] = fixture.NullColumn()
	}
	payload := exactPrefixedPayload(t, prefix, 500)
	cell := mustCell(t, testLayout(0), 9, payload.Bytes, fixture.Options{})
	headerEnd := payload.HeaderSize
	localEnd := cell.LocalLength
	if headerEnd <= localEnd {
		t.Fatalf("header size %d does not cross local length %d", headerEnd, localEnd)
	}
	reader := &auditReader{file: cell.File}
	result := mustProject(t, reader, generousConfig(cell), cell, []int{0, 79, 80})
	if result.Columns[0].Kind != dataeng.ValueNull || result.Columns[1].Kind != dataeng.ValueNull {
		t.Fatalf("null columns decoded incorrectly: %+v", result.Columns[:2])
	}
	if !bytes.Equal(result.Columns[2].Blob, payload.Bytes[payload.DataOffsets[80]:]) {
		t.Fatalf("blob after a split header decoded incorrectly")
	}
	headerReadOnOverflow := false
	for _, read := range result.Reads {
		if read.Purpose == dataeng.ReadRecordHeader && read.Page != cell.CellPage {
			headerReadOnOverflow = true
		}
	}
	if !headerReadOnOverflow {
		t.Fatalf("header was not read from the overflow page")
	}
}

func TestProjectedValueSpansTwoOverflowPages(t *testing.T) {
	payload := exactBlobPayload(t, 922)
	cell := mustCell(t, testLayout(0), 3, payload.Bytes, fixture.Options{})
	reader := &auditReader{file: cell.File}
	result := mustProject(t, reader, generousConfig(cell), cell, []int{0})
	segments := result.Columns[0].Segments
	if len(segments) != 3 {
		t.Fatalf("value has %d segments, want local + two overflow pages: %+v", len(segments), segments)
	}
	for i, segment := range segments {
		if i == 0 && segment.Location != dataeng.SpanCell {
			t.Fatalf("first segment location %v", segment.Location)
		}
		if i > 0 && segment.Location != dataeng.SpanOverflow {
			t.Fatalf("segment %d location %v", i, segment.Location)
		}
	}
	if len(result.OverflowPages) != 2 {
		t.Fatalf("overflow pages %d, want 2", len(result.OverflowPages))
	}
}

func TestUnprojectedLargeBlobIsNeverRead(t *testing.T) {
	large := patterned(2000)
	payload, err := fixture.BuildPayload([]fixture.Column{
		fixture.IntegerColumn(-123456789),
		fixture.BlobColumn(large),
		fixture.BlobColumn(nil),
		fixture.NullColumn(),
	})
	if err != nil {
		t.Fatalf("BuildPayload: %v", err)
	}
	cell := mustCell(t, testLayout(30), 11, payload.Bytes, fixture.Options{})
	blobStart := payload.DataOffsets[1]
	forbidden := logicalIntervals(cell, blobStart, uint64(len(large)))
	if len(forbidden) < 3 {
		t.Fatalf("large blob only spans %d physical intervals", len(forbidden))
	}
	before := append([]byte(nil), cell.File...)
	reader := &auditReader{file: cell.File, forbidden: forbidden}
	result := mustProject(t, reader, generousConfig(cell), cell, []int{0, 2, 3, 2})
	if result.Columns[0].Integer != -123456789 {
		t.Fatalf("integer %d", result.Columns[0].Integer)
	}
	if result.Columns[1].Kind != dataeng.ValueBlob || result.Columns[1].Blob == nil || len(result.Columns[1].Blob) != 0 {
		t.Fatalf("empty blob is not distinct: %+v", result.Columns[1])
	}
	if result.Columns[2].Kind != dataeng.ValueNull || result.Columns[2].Blob != nil {
		t.Fatalf("null is not distinct: %+v", result.Columns[2])
	}
	if result.Columns[3].Kind != dataeng.ValueBlob || len(result.Columns[3].Blob) != 0 {
		t.Fatalf("duplicate empty blob is wrong: %+v", result.Columns[3])
	}
	assertReadMatches(t, reader, result)
	if !bytes.Equal(before, cell.File) {
		t.Fatalf("projection modified the immutable fixture snapshot")
	}
}

func TestProjectionOrderDuplicatesAndFreshCopies(t *testing.T) {
	blob := patterned(50)
	payload, err := fixture.BuildPayload([]fixture.Column{
		fixture.NullColumn(),
		fixture.BlobColumn(blob),
		fixture.BlobColumn(nil),
	})
	if err != nil {
		t.Fatalf("BuildPayload: %v", err)
	}
	cell := mustCell(t, testLayout(20), 5, payload.Bytes, fixture.Options{})
	result := mustProject(t, &auditReader{file: cell.File}, generousConfig(cell), cell, []int{1, 0, 1, 2})
	if len(result.Columns) != 4 {
		t.Fatalf("projection count %d", len(result.Columns))
	}
	if result.Columns[0].ColumnIndex != 1 || result.Columns[1].ColumnIndex != 0 ||
		result.Columns[2].ColumnIndex != 1 || result.Columns[3].ColumnIndex != 2 {
		t.Fatalf("projection order was not preserved: %+v", result.Columns)
	}
	result.Columns[0].Blob[0] ^= 0xff
	if !bytes.Equal(result.Columns[2].Blob, blob) {
		t.Fatalf("duplicate occurrence aliases the first returned blob")
	}
	if result.Columns[1].Blob != nil {
		t.Fatalf("null blob should be nil")
	}
	if result.Columns[3].Blob == nil {
		t.Fatalf("empty blob should be non-nil")
	}
}

func TestChainExactAndExtraPage(t *testing.T) {
	payload := exactBlobPayload(t, 922)
	exact := mustCell(t, testLayout(0), 1, payload.Bytes, fixture.Options{})
	result := mustProject(t, &auditReader{file: exact.File}, generousConfig(exact), exact, []int{0})
	if len(result.OverflowPages) != 2 {
		t.Fatalf("exact chain pages %d", len(result.OverflowPages))
	}
	lastPage := result.OverflowPages[len(result.OverflowPages)-1].Page
	linkOffset, err := exact.PageStart(lastPage)
	if err != nil {
		t.Fatalf("PageStart: %v", err)
	}
	if got := binary.BigEndian.Uint32(exact.File[linkOffset : linkOffset+4]); got != 0 {
		t.Fatalf("exact chain final link = %d, want 0", got)
	}

	extra := mustCell(t, testLayout(0), 1, payload.Bytes, fixture.Options{
		ExtraFinalLink: 4,
		TotalPages:     4,
	})
	reader := &auditReader{file: extra.File}
	got, err := dataeng.Project(reader, generousConfig(extra), extra.Ref(), []int{0})
	if got != nil || !errors.Is(err, dataeng.ErrOverflowChainExtra) {
		t.Fatalf("extra chain: result=%v err=%v", got, err)
	}
}

func TestOverflowChainFailures(t *testing.T) {
	payload := exactBlobPayload(t, 922)
	base := mustCell(t, testLayout(0), 1, payload.Bytes, fixture.Options{})

	tests := []struct {
		name      string
		mutate    func(*fixture.Cell)
		wantError error
	}{
		{
			name: "early-zero",
			mutate: func(cell *fixture.Cell) {
				if err := fixture.SetLink(cell.File, cell.PageSize, cell.OverflowPages[0], 0); err != nil {
					t.Fatalf("SetLink: %v", err)
				}
			},
			wantError: dataeng.ErrOverflowChainEarly,
		},
		{
			name: "self-cycle",
			mutate: func(cell *fixture.Cell) {
				if err := fixture.SetLink(cell.File, cell.PageSize, cell.OverflowPages[0], cell.OverflowPages[0]); err != nil {
					t.Fatalf("SetLink: %v", err)
				}
			},
			wantError: dataeng.ErrOverflowChainCycle,
		},
		{
			name: "back-to-cell",
			mutate: func(cell *fixture.Cell) {
				if err := fixture.SetLink(cell.File, cell.PageSize, cell.OverflowPages[0], cell.CellPage); err != nil {
					t.Fatalf("SetLink: %v", err)
				}
			},
			wantError: dataeng.ErrOverflowChainCycle,
		},
		{
			name: "out-of-range",
			mutate: func(cell *fixture.Cell) {
				if err := fixture.SetLink(cell.File, cell.PageSize, cell.OverflowPages[0], cell.TotalPages+100); err != nil {
					t.Fatalf("SetLink: %v", err)
				}
			},
			wantError: dataeng.ErrOverflowOutOfRange,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			clone := *base
			clone.File = append([]byte(nil), base.File...)
			tc.mutate(&clone)
			result, err := dataeng.Project(&auditReader{file: clone.File}, generousConfig(&clone), clone.Ref(), []int{0})
			if result != nil || !errors.Is(err, tc.wantError) {
				t.Fatalf("result=%v err=%v, want %v", result, err, tc.wantError)
			}
		})
	}
}

func TestReservedTailAndOverflowTailGarbageNeverRead(t *testing.T) {
	payload := exactBlobPayload(t, 922)
	cell := mustCell(t, testLayout(0), 1, payload.Bytes, fixture.Options{
		ReservedFill:     0x7a,
		OverflowTailFill: 0x5b,
	})
	reader := &auditReader{
		file:      cell.File,
		forbidden: append(reservedIntervals(cell), unusedOverflowIntervals(cell)...),
	}
	result := mustProject(t, reader, generousConfig(cell), cell, []int{0})
	if !bytes.Equal(result.Columns[0].Blob, payload.Bytes[payload.HeaderSize:]) {
		t.Fatalf("garbage tail changed projected payload")
	}
	assertReadMatches(t, reader, result)
}

func TestHeaderBodyMismatch(t *testing.T) {
	payload, err := fixture.BuildPayload([]fixture.Column{
		{SerialType: 12 + 2*3, Data: []byte{0x11, 0x22}},
	})
	if err != nil {
		t.Fatalf("BuildPayload: %v", err)
	}
	cell := mustCell(t, testLayout(0), 1, payload.Bytes, fixture.Options{})
	reader := &auditReader{file: cell.File}
	result, err := dataeng.Project(reader, generousConfig(cell), cell.Ref(), []int{0})
	if result != nil || !errors.Is(err, dataeng.ErrRecordLengthMismatch) {
		t.Fatalf("result=%v err=%v, want ErrRecordLengthMismatch", result, err)
	}
}

func TestUnsupportedSerialTypes(t *testing.T) {
	for _, serial := range []uint64{1, 2, 5, 7, 8, 9, 10, 11, 13, 15} {
		t.Run(fmt.Sprintf("serial-%d", serial), func(t *testing.T) {
			payload, err := fixture.BuildPayload([]fixture.Column{{SerialType: serial}})
			if err != nil {
				t.Fatalf("BuildPayload: %v", err)
			}
			cell := mustCell(t, testLayout(0), 1, payload.Bytes, fixture.Options{})
			result, err := dataeng.Project(&auditReader{file: cell.File}, generousConfig(cell), cell.Ref(), []int{})
			if result != nil || !errors.Is(err, dataeng.ErrUnsupportedSerial) {
				t.Fatalf("serial %d: result=%v err=%v", serial, result, err)
			}
		})
	}
}

func TestBudgetsAndProjectionBounds(t *testing.T) {
	blob := patterned(100)
	payload, err := fixture.BuildPayload([]fixture.Column{fixture.BlobColumn(blob)})
	if err != nil {
		t.Fatalf("BuildPayload: %v", err)
	}
	cell := mustCell(t, testLayout(20), 1, payload.Bytes, fixture.Options{})

	t.Run("header-budget", func(t *testing.T) {
		config := cell.Config(uint64(payload.HeaderSize-1), 10, 1000)
		result, err := dataeng.Project(&auditReader{file: cell.File}, config, cell.Ref(), []int{0})
		if result != nil || !errors.Is(err, dataeng.ErrBudgetExceeded) {
			t.Fatalf("result=%v err=%v", result, err)
		}
	})
	t.Run("projection-budget", func(t *testing.T) {
		config := cell.Config(100, 10, uint64(len(blob)-1))
		result, err := dataeng.Project(&auditReader{file: cell.File}, config, cell.Ref(), []int{0})
		if result != nil || !errors.Is(err, dataeng.ErrBudgetExceeded) {
			t.Fatalf("result=%v err=%v", result, err)
		}
	})
	t.Run("duplicate-projection-budget", func(t *testing.T) {
		config := cell.Config(100, 10, uint64(len(blob)+1))
		result, err := dataeng.Project(&auditReader{file: cell.File}, config, cell.Ref(), []int{0, 0})
		if result != nil || !errors.Is(err, dataeng.ErrBudgetExceeded) {
			t.Fatalf("duplicate projection exceeded budget but result=%v err=%v", result, err)
		}
	})
	t.Run("projection-order", func(t *testing.T) {
		result, err := dataeng.Project(&auditReader{file: cell.File}, generousConfig(cell), cell.Ref(), []int{0, -1})
		if result != nil || !errors.Is(err, dataeng.ErrProjectionOutOfRange) {
			t.Fatalf("result=%v err=%v", result, err)
		}
	})
}

func TestChainBudgetRejectsBeforeOverflowRead(t *testing.T) {
	payload := exactBlobPayload(t, 922)
	cell := mustCell(t, testLayout(0), 1, payload.Bytes, fixture.Options{})
	reader := &auditReader{file: cell.File}
	config := cell.Config(1<<20, uint64(len(cell.OverflowPages)-1), 1<<20)
	result, err := dataeng.Project(reader, config, cell.Ref(), []int{0})
	if result != nil || !errors.Is(err, dataeng.ErrBudgetExceeded) {
		t.Fatalf("result=%v err=%v", result, err)
	}
	for _, request := range reader.requests {
		if request.offset >= int64(testPageSize) {
			t.Fatalf("chain budget rejection still read an overflow page: [%d,%d)", request.offset, request.offset+int64(request.length))
		}
	}
}

func TestShortReadAndCellLengthMismatch(t *testing.T) {
	payload := exactBlobPayload(t, 903)
	cell := mustCell(t, testLayout(0), 1, payload.Bytes, fixture.Options{})

	lastPage := cell.OverflowPages[len(cell.OverflowPages)-1]
	lastPageStart, err := cell.PageStart(lastPage)
	if err != nil {
		t.Fatalf("PageStart: %v", err)
	}
	// The final overflow page contributes four payload bytes. Leave only
	// three of them in the file by cutting the fourth and everything after it.
	cut := len(cell.File) - int(lastPageStart+4+3)
	short, err := cell.Truncate(cut)
	if err != nil {
		t.Fatalf("Truncate: %v", err)
	}
	result, err := dataeng.Project(&auditReader{file: short.File}, generousConfig(short), short.Ref(), []int{0})
	if result != nil || !errors.Is(err, dataeng.ErrShortRead) {
		t.Fatalf("short read: result=%v err=%v", result, err)
	}

	badRef := cell.Ref()
	badRef.Length--
	result, err = dataeng.Project(&auditReader{file: cell.File}, generousConfig(cell), badRef, []int{0})
	if result != nil || !errors.Is(err, dataeng.ErrCellLengthMismatch) {
		t.Fatalf("length mismatch: result=%v err=%v", result, err)
	}

	badRef = cell.Ref()
	badRef.Offset = testUsable - badRef.Length + 1
	result, err = dataeng.Project(&auditReader{file: cell.File}, generousConfig(cell), badRef, []int{0})
	if result != nil || !errors.Is(err, dataeng.ErrInvalidCell) {
		t.Fatalf("reserved overlap: result=%v err=%v", result, err)
	}
}

func TestConfigValidation(t *testing.T) {
	tests := []dataeng.Config{
		{PageSize: 511, ReservedBytes: 0, PageCount: 1},
		{PageSize: 1024, ReservedBytes: 600, PageCount: 1},
		{PageSize: 1024, ReservedBytes: -1, PageCount: 1},
		{PageSize: 512, ReservedBytes: 0, PageCount: 0},
	}
	for _, config := range tests {
		if _, err := dataeng.NewProjector(&auditReader{}, config); !errors.Is(err, dataeng.ErrInvalidConfig) {
			t.Fatalf("config %+v: err=%v, want ErrInvalidConfig", config, err)
		}
	}
}

func TestPageSizeAndPageNumberExtremes(t *testing.T) {
	t.Run("largest-page-no-overflow", func(t *testing.T) {
		payload := exactBlobPayload(t, 65000)
		layout := fixture.Layout{PageSize: 65536, ReservedBytes: 0, CellPage: 1, CellOffset: 0}
		cell := mustCell(t, layout, 8, payload.Bytes, fixture.Options{})
		if cell.FirstOverflowPage != 0 {
			t.Fatalf("65000-byte payload unexpectedly overflowed at U=%d", 65536)
		}
		result := mustProject(t, &auditReader{file: cell.File}, generousConfig(cell), cell, []int{0})
		if !bytes.Equal(result.Columns[0].Blob, payload.Bytes[payload.HeaderSize:]) {
			t.Fatalf("large-page payload mismatch")
		}
	})
	t.Run("largest-page-largest-reserved-area", func(t *testing.T) {
		payload := exactBlobPayload(t, 446)
		layout := fixture.Layout{
			PageSize:      65536,
			ReservedBytes: 65536 - 480,
			CellPage:      1,
			CellOffset:    0,
		}
		cell := mustCell(t, layout, 9, payload.Bytes, fixture.Options{})
		reader := &auditReader{file: cell.File, forbidden: reservedIntervals(cell)}
		_ = mustProject(t, reader, generousConfig(cell), cell, []int{0})
	})
	t.Run("cell-page-after-overflow-pages", func(t *testing.T) {
		payload := exactBlobPayload(t, 922)
		layout := fixture.Layout{PageSize: 512, ReservedBytes: 32, CellPage: 3, CellOffset: 40}
		cell := mustCell(t, layout, 10, payload.Bytes, fixture.Options{FirstOverflowPage: 1})
		if cell.CellPage != 3 || len(cell.OverflowPages) != 2 ||
			cell.OverflowPages[0] != 1 || cell.OverflowPages[1] != 2 {
			t.Fatalf("unexpected non-monotonic layout: cell=%d overflow=%v", cell.CellPage, cell.OverflowPages)
		}
		result := mustProject(t, &auditReader{file: cell.File}, generousConfig(cell), cell, []int{0})
		if result.Columns[0].Segments[0].Page != 3 {
			t.Fatalf("local segment page %d, want cell page 3", result.Columns[0].Segments[0].Page)
		}
		if len(result.OverflowPages) != 2 || result.OverflowPages[0].Page != 1 {
			t.Fatalf("overflow directory %+v", result.OverflowPages)
		}
	})
}
