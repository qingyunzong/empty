package dataeng

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"sort"
)

// Projector reuses validated snapshot geometry. The supplied ReaderAt must be
// immutable for the lifetime of all projections.
type Projector struct {
	reader io.ReaderAt
	cfg    Config
	usable int
}

// NewProjector validates configuration only. It does not read the snapshot.
func NewProjector(reader io.ReaderAt, cfg Config) (*Projector, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	if reader == nil {
		return nil, &Error{Cause: ErrInvalidConfig, Detail: "nil ReaderAt"}
	}
	return &Projector{reader: reader, cfg: cfg, usable: cfg.usablePageSize()}, nil
}

// Project is a convenience wrapper around NewProjector and Projector.Project.
func Project(reader io.ReaderAt, cfg Config, cell CellRef, columns []int) (*Result, error) {
	projector, err := NewProjector(reader, cfg)
	if err != nil {
		return nil, err
	}
	return projector.Project(cell, columns)
}

// Project projects the selected columns after validating the complete target
// payload chain, all serial-type varints, and the complete body length.
func (p *Projector) Project(cell CellRef, columns []int) (*Result, error) {
	return p.ProjectContext(context.Background(), cell, columns)
}

// ProjectContext is Project with cancellation support. Cancellation is checked
// before each ReaderAt request.
func (p *Projector) ProjectContext(ctx context.Context, cell CellRef, columns []int) (*Result, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	op := &operation{
		projector: p,
		ctx:       ctx,
		cell:      cell,
		columns:   columns,
	}
	result, err := op.run()
	if err != nil {
		var projectErr *Error
		if errors.As(err, &projectErr) {
			projectErr.Reads = cloneReads(op.reads)
			return nil, projectErr
		}
		return nil, &Error{Cause: err, Reads: cloneReads(op.reads)}
	}
	return result, nil
}

type operation struct {
	projector *Projector
	ctx       context.Context
	cell      CellRef
	columns   []int
	reads     []ReadEvent
	layout    *payloadLayout
}

type payloadSpan struct {
	page          uint64
	pageOffset    uint64
	logicalOffset uint64
	length        uint64
	location      SpanLocation
}

type payloadLayout struct {
	spans     []payloadSpan
	local     uint64
	firstPage uint64
	overflow  []OverflowPage
	pLength   uint64
}

type columnInfo struct {
	kind       ValueKind
	length     uint64
	dataOffset uint64
}

func (op *operation) run() (*Result, error) {
	if err := op.validateCellRef(); err != nil {
		return nil, err
	}

	pLength, rowID, prefixLen, err := op.readCellPrefix()
	if err != nil {
		return nil, err
	}
	localLength, hasOverflow, err := localPayloadLength(pLength, op.projector.usable)
	if err != nil {
		return nil, op.fail(ErrInvalidCell, "%v", err)
	}

	expectedCellLength := uint64(prefixLen) + localLength
	if hasOverflow {
		if expectedCellLength > math.MaxUint64-4 {
			return nil, op.fail(ErrInvalidCell, "cell length overflow")
		}
		expectedCellLength += 4
	}
	if expectedCellLength != uint64(op.cell.Length) {
		return nil, op.fail(ErrCellLengthMismatch,
			"declared cell length %d, components require %d (P=%d, local=%d, overflow=%t, prefix=%d)",
			op.cell.Length, expectedCellLength, pLength, localLength, hasOverflow, prefixLen)
	}
	if uint64(op.cell.Offset)+expectedCellLength > uint64(op.projector.usable) {
		return nil, op.fail(ErrInvalidCell, "cell enters the reserved page tail")
	}

	var firstPage uint64
	if hasOverflow {
		physicalOffset := prefixLen + int(localLength)
		header, err := op.readPage(
			op.cell.Page, op.cell.Offset+physicalOffset, 4,
			ReadOverflowLink, SpanCell, 0, 0,
		)
		if err != nil {
			return nil, err
		}
		firstPage = uint64(binary.BigEndian.Uint32(header))
	}

	layout, err := op.buildLayout(pLength, localLength, firstPage, prefixLen, hasOverflow)
	if err != nil {
		return nil, err
	}
	op.layout = layout
	columns, err := op.parseRecord(layout)
	if err != nil {
		return nil, err
	}
	if err := op.checkProjections(columns); err != nil {
		return nil, err
	}
	result, err := op.materialize(rowID, layout, columns)
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (op *operation) validateCellRef() error {
	if op.cell.Page < 1 || op.cell.Page > op.projector.cfg.PageCount {
		return op.fail(ErrInvalidCell, "page %d is outside [1,%d]", op.cell.Page, op.projector.cfg.PageCount)
	}
	if op.cell.Offset < 0 {
		return op.fail(ErrInvalidCell, "negative cell offset %d", op.cell.Offset)
	}
	if op.cell.Length <= 0 {
		return op.fail(ErrInvalidCell, "cell length must be positive")
	}
	if int64(op.cell.Offset) > int64(op.projector.usable)-int64(op.cell.Length) {
		return op.fail(ErrInvalidCell,
			"cell [%d,%d) is not wholly inside usable page bytes [0,%d)",
			op.cell.Offset, op.cell.Offset+op.cell.Length, op.projector.usable)
	}
	return nil
}

// readCellPrefix reads the two cell varints one byte at a time. It never reads
// over them into the local payload.
func (op *operation) readCellPrefix() (uint64, int64, int, error) {
	cursor := 0
	fetch := func() (byte, error) {
		if cursor < 0 || cursor >= op.cell.Length {
			return 0, op.fail(ErrVarintTruncated, "cell varint at relative offset %d", cursor)
		}
		b, err := op.readPage(
			op.cell.Page, op.cell.Offset+cursor, 1,
			ReadCellVarint, SpanCell, 0, 0,
		)
		if err != nil {
			return 0, err
		}
		cursor++
		return b[0], nil
	}

	pLength, pLen, err := decodeVarint(fetch)
	if err != nil {
		return 0, 0, 0, err
	}
	rowBits, rowLen, err := decodeVarint(fetch)
	if err != nil {
		return 0, 0, 0, err
	}
	return pLength, int64(rowBits), pLen + rowLen, nil
}

func decodeVarint(fetch func() (byte, error)) (uint64, int, error) {
	var value uint64
	for i := 0; i < 8; i++ {
		b, err := fetch()
		if err != nil {
			return 0, 0, err
		}
		value = (value << 7) | uint64(b&0x7f)
		if b&0x80 == 0 {
			return value, i + 1, nil
		}
	}
	b, err := fetch()
	if err != nil {
		return 0, 0, err
	}
	value = (value << 8) | uint64(b)
	return value, 9, nil
}

func localPayloadLength(payloadLength uint64, usable int) (local uint64, overflow bool, err error) {
	if usable < MinUsablePageSize {
		return 0, false, fmt.Errorf("usable page size %d is too small", usable)
	}
	u := uint64(usable)
	threshold := u - 35
	if payloadLength <= threshold {
		return payloadLength, false, nil
	}
	m := ((u-12)*32)/255 - 23
	if payloadLength < m {
		return 0, false, fmt.Errorf("payload length %d lies below local minimum %d", payloadLength, m)
	}
	k := m + (payloadLength-m)%(u-4)
	if k <= threshold {
		return k, true, nil
	}
	return m, true, nil
}

func (op *operation) buildLayout(
	pLength, localLength, firstPage uint64, prefixLen int, hasOverflow bool,
) (*payloadLayout, error) {
	layout := &payloadLayout{
		local:     localLength,
		firstPage: firstPage,
		pLength:   pLength,
	}
	if localLength > 0 {
		layout.spans = append(layout.spans, payloadSpan{
			page:          op.cell.Page,
			pageOffset:    uint64(op.cell.Offset + prefixLen),
			logicalOffset: 0,
			length:        localLength,
			location:      SpanCell,
		})
	}
	if !hasOverflow {
		if pLength != localLength {
			return nil, op.fail(ErrInvalidCell, "payload length %d does not equal local length %d without overflow", pLength, localLength)
		}
		return layout, nil
	}

	remaining := pLength - localLength
	capacity := uint64(op.projector.usable - 4)
	required := remaining / capacity
	if remaining%capacity != 0 {
		required++
	}
	if required > op.projector.cfg.ChainPageBudget {
		return nil, op.fail(ErrBudgetExceeded,
			"overflow chain needs %d pages, budget is %d", required, op.projector.cfg.ChainPageBudget)
	}
	maxInt := uint64(^uint(0) >> 1)
	if required > maxInt {
		return nil, op.fail(ErrBudgetExceeded, "overflow directory length %d exceeds platform limits", required)
	}
	if firstPage == 0 {
		return nil, op.fail(ErrOverflowChainEarly, "first overflow page is zero while %d payload bytes remain", remaining)
	}

	visited := map[uint64]struct{}{op.cell.Page: {}}
	layout.spans = append(make([]payloadSpan, 0, int(required)+len(layout.spans)), layout.spans...)
	layout.overflow = make([]OverflowPage, 0, int(required))
	next := firstPage
	logical := localLength
	for remaining > 0 {
		if next == 0 {
			return nil, op.fail(ErrOverflowChainEarly, "overflow chain ends with %d payload bytes still missing", remaining)
		}
		if next < 1 || next > op.projector.cfg.PageCount {
			return nil, op.fail(ErrOverflowOutOfRange, "overflow page %d is outside [1,%d]", next, op.projector.cfg.PageCount)
		}
		if _, seen := visited[next]; seen {
			return nil, op.fail(ErrOverflowChainCycle, "overflow page %d repeats or refers back to the cell page", next)
		}
		visited[next] = struct{}{}

		linkBytes, err := op.readPage(
			next, 0, 4, ReadOverflowLink, SpanOverflow, logical, 0,
		)
		if err != nil {
			return nil, err
		}
		link := uint64(binary.BigEndian.Uint32(linkBytes))
		spanLength := remaining
		if spanLength > capacity {
			spanLength = capacity
		}
		span := payloadSpan{
			page:          next,
			pageOffset:    4,
			logicalOffset: logical,
			length:        spanLength,
			location:      SpanOverflow,
		}
		layout.spans = append(layout.spans, span)
		layout.overflow = append(layout.overflow, OverflowPage{
			Page:          next,
			PageOffset:    4,
			LogicalOffset: logical,
			Length:        spanLength,
		})
		logical += spanLength
		remaining -= spanLength
		next = link
	}

	if next != 0 {
		return nil, op.fail(ErrOverflowChainExtra,
			"overflow chain has an extra page %d after the final required payload byte", next)
	}
	if logical != pLength {
		return nil, op.fail(ErrInvalidCell, "overflow chain covered %d logical bytes, expected %d", logical, pLength)
	}
	return layout, nil
}

// parseRecord parses the complete header, validates every serial type and the
// complete body layout, and returns metadata for all columns.
func (op *operation) parseRecord(layout *payloadLayout) ([]columnInfo, error) {
	headerSize, hLen, err := op.logicalVarint(0, layout.pLength, ErrVarintTruncated)
	if err != nil {
		return nil, err
	}
	if headerSize < uint64(hLen) {
		return nil, op.fail(ErrHeaderInvalid, "header size %d is smaller than its own varint (%d bytes)", headerSize, hLen)
	}
	if headerSize > layout.pLength {
		return nil, op.fail(ErrHeaderInvalid, "header size %d exceeds payload length %d", headerSize, layout.pLength)
	}
	if headerSize > op.projector.cfg.HeaderByteBudget {
		return nil, op.fail(ErrBudgetExceeded,
			"record header needs %d bytes, budget is %d", headerSize, op.projector.cfg.HeaderByteBudget)
	}

	var serialTypes []uint64
	cursor := uint64(hLen)
	for cursor < headerSize {
		serial, length, err := op.logicalVarint(cursor, headerSize, ErrHeaderInvalid)
		if err != nil {
			return nil, err
		}
		serialTypes = append(serialTypes, serial)
		cursor += uint64(length)
	}
	if cursor != headerSize {
		return nil, op.fail(ErrHeaderInvalid, "header varints end at offset %d, header size is %d", cursor, headerSize)
	}

	columns := make([]columnInfo, 0, len(serialTypes))
	bodyLength := layout.pLength - headerSize
	var total uint64
	var dataOffset = headerSize
	for i, serial := range serialTypes {
		kind, length, err := serialLayout(serial)
		if err != nil {
			return nil, op.fail(ErrUnsupportedSerial, "column %d has serial type %d", i, serial)
		}
		if length > math.MaxUint64-total {
			return nil, op.fail(ErrRecordLengthMismatch,
				"body length overflows uint64 after column %d", i)
		}
		total += length
		columns = append(columns, columnInfo{
			kind:       kind,
			length:     length,
			dataOffset: dataOffset,
		})
		if length > math.MaxUint64-dataOffset {
			return nil, op.fail(ErrRecordLengthMismatch,
				"column data offset overflows uint64 after column %d", i)
		}
		dataOffset += length
	}
	if total != bodyLength {
		return nil, op.fail(ErrRecordLengthMismatch,
			"all column lengths sum to %d, body length is %d (P=%d, header=%d, columns=%d)",
			total, bodyLength, layout.pLength, headerSize, len(columns))
	}
	return columns, nil
}

func serialLayout(serial uint64) (ValueKind, uint64, error) {
	switch {
	case serial == 0:
		return ValueNull, 0, nil
	case serial == 6:
		return ValueInteger, 8, nil
	case serial >= 12 && serial%2 == 0:
		return ValueBlob, (serial - 12) / 2, nil
	default:
		return 0, 0, fmt.Errorf("serial type %d", serial)
	}
}

func (op *operation) logicalVarint(offset, limit uint64, boundaryCause error) (uint64, int, error) {
	cursor := offset
	fetch := func() (byte, error) {
		if cursor >= limit {
			return 0, op.fail(boundaryCause, "varint at logical offset %d crosses limit %d", offset, limit)
		}
		b, err := op.readLogical(cursor, 1, ReadRecordHeader)
		if err != nil {
			return 0, err
		}
		cursor++
		return b[0], nil
	}
	return decodeVarint(fetch)
}

func (op *operation) checkProjections(columns []columnInfo) error {
	for _, index := range op.columns {
		if index < 0 || index >= len(columns) {
			return op.fail(ErrProjectionOutOfRange,
				"projection index %d is outside [0,%d)", index, len(columns))
		}
	}
	var total uint64
	for _, index := range op.columns {
		length := columns[index].length
		if length > op.projector.cfg.ProjectionByteBudget-total {
			return op.fail(ErrBudgetExceeded,
				"projected column bytes exceed budget %d at column %d", op.projector.cfg.ProjectionByteBudget, index)
		}
		total += length
	}
	return nil
}

type cachedValue struct {
	kind    ValueKind
	integer int64
	blob    []byte
}

func (op *operation) materialize(rowID int64, layout *payloadLayout, columns []columnInfo) (*Result, error) {
	result := &Result{
		RowID:             rowID,
		PayloadLength:     layout.pLength,
		LocalLength:       layout.local,
		CellPage:          op.cell.Page,
		CellOffset:        op.cell.Offset,
		CellLength:        op.cell.Length,
		FirstOverflowPage: layout.firstPage,
		OverflowPages:     cloneOverflow(layout.overflow),
		Reads:             cloneReads(op.reads),
	}
	result.Columns = make([]ColumnValue, 0, len(op.columns))
	cache := make(map[int]cachedValue)

	for _, index := range op.columns {
		column := columns[index]
		value, ok := cache[index]
		if !ok {
			var err error
			value, err = op.readColumn(index, column)
			if err != nil {
				return nil, err
			}
			cache[index] = value
		}

		projected := ColumnValue{
			ColumnIndex:   index,
			Kind:          value.kind,
			LogicalOffset: column.dataOffset,
			Length:        column.length,
			Segments:      cloneSegments(op.logicalSegments(column.dataOffset, column.length)),
		}
		switch value.kind {
		case ValueInteger:
			projected.Integer = value.integer
		case ValueBlob:
			projected.Blob = cloneBytes(value.blob)
		}
		result.Columns = append(result.Columns, projected)
	}
	result.Reads = cloneReads(op.reads)
	return result, nil
}

func (op *operation) readColumn(index int, column columnInfo) (cachedValue, error) {
	switch column.kind {
	case ValueNull:
		return cachedValue{kind: ValueNull}, nil
	case ValueInteger:
		raw, err := op.readLogical(column.dataOffset, 8, ReadProjectedValue)
		if err != nil {
			return cachedValue{}, err
		}
		return cachedValue{
			kind:    ValueInteger,
			integer: int64(binary.BigEndian.Uint64(raw)),
		}, nil
	case ValueBlob:
		if column.length == 0 {
			return cachedValue{kind: ValueBlob, blob: make([]byte, 0)}, nil
		}
		raw, err := op.readLogical(column.dataOffset, column.length, ReadProjectedValue)
		if err != nil {
			return cachedValue{}, err
		}
		return cachedValue{kind: ValueBlob, blob: raw}, nil
	default:
		return cachedValue{}, op.fail(ErrUnsupportedSerial, "column %d kind %s", index, column.kind)
	}
}

func (op *operation) readLogical(offset, length uint64, purpose ReadPurpose) ([]byte, error) {
	if length == 0 {
		return make([]byte, 0), nil
	}
	if offset > op.currentPayloadLength() || length > op.currentPayloadLength()-offset {
		return nil, op.fail(ErrPayloadOutOfRange,
			"logical interval [%d,%d) is outside payload length %d", offset, offset+length, op.currentPayloadLength())
	}
	maxInt := uint64(^uint(0) >> 1)
	if length > maxInt {
		return nil, op.fail(ErrBudgetExceeded, "logical read length %d exceeds platform limits", length)
	}
	out := make([]byte, int(length))
	remaining := length
	position := offset
	for remaining > 0 {
		span, spanOffset, err := op.findSpan(position)
		if err != nil {
			return nil, err
		}
		chunk := span.length - spanOffset
		if chunk > remaining {
			chunk = remaining
		}
		physical := int(span.pageOffset + spanOffset)
		raw, err := op.readPage(
			span.page, physical, int(chunk), purpose, span.location,
			span.logicalOffset+spanOffset, chunk,
		)
		if err != nil {
			return nil, err
		}
		copied := uint64(copy(out[int(length-remaining):], raw))
		if copied != chunk {
			return nil, op.fail(ErrShortRead, "internal copy copied %d of %d bytes", copied, chunk)
		}
		remaining -= chunk
		position += chunk
	}
	return out, nil
}

// currentPayloadLength is available after the chain directory is built and
// before any record-header or value read is attempted.
func (op *operation) currentPayloadLength() uint64 {
	if op.layout != nil {
		return op.layout.pLength
	}
	return 0
}

// findSpan locates the physical span covering position. It is kept as a
// method so the read path never scans or materializes the payload.
func (op *operation) findSpan(position uint64) (payloadSpan, uint64, error) {
	spans := op.layout.spans
	index := sort.Search(len(spans), func(i int) bool {
		return spans[i].logicalOffset+spans[i].length > position
	})
	if index >= len(spans) {
		return payloadSpan{}, 0, op.fail(ErrPayloadOutOfRange,
			"logical offset %d is not covered by the payload directory", position)
	}
	span := spans[index]
	if position < span.logicalOffset || position >= span.logicalOffset+span.length {
		return payloadSpan{}, 0, op.fail(ErrPayloadOutOfRange,
			"logical offset %d is not covered by the payload directory", position)
	}
	return span, position - span.logicalOffset, nil
}

func (op *operation) logicalSegments(offset, length uint64) []Segment {
	if length == 0 {
		return nil
	}
	var segments []Segment
	remaining := length
	position := offset
	for remaining > 0 {
		spanOffset, span := op.segmentAt(position)
		if span == nil {
			return segments
		}
		chunk := span.length - spanOffset
		if chunk > remaining {
			chunk = remaining
		}
		segments = append(segments, Segment{
			Page:          span.page,
			PageOffset:    span.pageOffset + spanOffset,
			LogicalOffset: span.logicalOffset + spanOffset,
			Length:        chunk,
			Location:      span.location,
		})
		remaining -= chunk
		position += chunk
	}
	return segments
}

func (op *operation) segmentAt(position uint64) (uint64, *payloadSpan) {
	if op.layout == nil {
		return 0, nil
	}
	spans := op.layout.spans
	index := sort.Search(len(spans), func(i int) bool {
		return spans[i].logicalOffset+spans[i].length > position
	})
	if index >= len(spans) {
		return 0, nil
	}
	span := &spans[index]
	if position < span.logicalOffset {
		return 0, nil
	}
	return position - span.logicalOffset, span
}

func (op *operation) readPage(
	page uint64,
	pageOffset, length int,
	purpose ReadPurpose,
	location SpanLocation,
	logicalOffset, logicalLength uint64,
) ([]byte, error) {
	if err := op.ctx.Err(); err != nil {
		return nil, op.fail(err, "projection cancelled")
	}
	if page < 1 || page > op.projector.cfg.PageCount {
		return nil, op.fail(ErrOverflowOutOfRange, "page %d is outside [1,%d]", page, op.projector.cfg.PageCount)
	}
	if pageOffset < 0 || length < 0 || int64(pageOffset)+int64(length) > int64(op.projector.usable) {
		return nil, op.fail(ErrInvalidCell,
			"read [%d,%d) is outside usable page bytes [0,%d)",
			pageOffset, pageOffset+length, op.projector.usable)
	}
	fileOffset := int64(page-1)*int64(op.projector.cfg.PageSize) + int64(pageOffset)
	event := ReadEvent{
		Page:          page,
		PageOffset:    pageOffset,
		FileOffset:    fileOffset,
		Length:        length,
		Purpose:       purpose,
		Location:      location,
		LogicalOffset: logicalOffset,
		LogicalLength: logicalLength,
	}
	op.reads = append(op.reads, event)
	if length == 0 {
		return make([]byte, 0), nil
	}
	buf := make([]byte, length)
	n, err := op.projector.reader.ReadAt(buf, fileOffset)
	if n != length {
		if err == nil {
			err = io.ErrUnexpectedEOF
		}
		return nil, op.fail(ErrShortRead,
			"ReaderAt(%d,%d) returned %d bytes: %v", fileOffset, length, n, err)
	}
	if err != nil {
		return nil, op.fail(ErrShortRead,
			"ReaderAt(%d,%d) returned %d bytes: %v", fileOffset, length, n, err)
	}
	return buf, nil
}

func (op *operation) fail(cause error, format string, args ...any) error {
	if cause == nil {
		cause = errors.New("dataeng: operation failed")
	}
	return &Error{
		Cause:  cause,
		Detail: fmt.Sprintf(format, args...),
		Reads:  cloneReads(op.reads),
	}
}

func cloneBytes(src []byte) []byte {
	dst := make([]byte, len(src))
	copy(dst, src)
	return dst
}

func cloneSegments(src []Segment) []Segment {
	if src == nil {
		return nil
	}
	dst := make([]Segment, len(src))
	copy(dst, src)
	return dst
}

func cloneOverflow(src []OverflowPage) []OverflowPage {
	if src == nil {
		return nil
	}
	dst := make([]OverflowPage, len(src))
	copy(dst, src)
	return dst
}

func cloneReads(src []ReadEvent) []ReadEvent {
	if src == nil {
		return nil
	}
	dst := make([]ReadEvent, len(src))
	copy(dst, src)
	return dst
}
