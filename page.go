package dataeng

import "math"

type pageFrame struct {
	width      float64
	height     float64
	topOrigin  bool
	bodyTop    float64
	bodyBottom float64
}

func (p Page) inferredWidth() float64 {
	if p.Width > 0 {
		return p.Width
	}
	var right float64
	for _, c := range p.Cells {
		right = maxFloat(right, c.Bounds.normalized().X1)
	}
	for _, b := range p.Borders {
		right = maxFloat(right, maxFloat(b.X0, b.X1))
	}
	for _, r := range []Rect{p.HeaderRegion, p.FooterRegion} {
		if !r.IsEmpty() {
			right = maxFloat(right, r.normalized().X1)
		}
	}
	if right <= 0 {
		return 1
	}
	return right
}

func (p Page) inferredHeight() float64 {
	if p.Height > 0 {
		return p.Height
	}
	var bottom float64
	for _, c := range p.Cells {
		bottom = maxFloat(bottom, c.Bounds.normalized().Y1)
	}
	for _, b := range p.Borders {
		bottom = maxFloat(bottom, maxFloat(b.Y0, b.Y1))
	}
	for _, r := range []Rect{p.HeaderRegion, p.FooterRegion} {
		if !r.IsEmpty() {
			bottom = maxFloat(bottom, r.normalized().Y1)
		}
	}
	if bottom <= 0 {
		return 1
	}
	return bottom
}

func (p Page) isTopOrigin(opts Options) bool {
	if opts.TopOrigin != nil {
		return *opts.TopOrigin
	}
	h := p.inferredHeight()
	headerEmpty := p.HeaderRegion.IsEmpty()
	footerEmpty := p.FooterRegion.IsEmpty()
	switch {
	case !headerEmpty && !footerEmpty:
		return p.HeaderRegion.CenterY() < p.FooterRegion.CenterY()
	case !headerEmpty:
		return p.HeaderRegion.CenterY() <= h/2
	case !footerEmpty:
		return p.FooterRegion.CenterY() > h/2
	default:
		return true
	}
}

func makePageFrame(p Page, opts Options) pageFrame {
	f := pageFrame{
		width:     p.inferredWidth(),
		height:    p.inferredHeight(),
		topOrigin: p.isTopOrigin(opts),
	}
	f.bodyTop = 0
	f.bodyBottom = f.height
	if !p.HeaderRegion.IsEmpty() {
		hr := f.toReading(p.HeaderRegion)
		if hr.Y1 > 0 && hr.Y1 < f.height {
			f.bodyTop = hr.Y1
		}
	}
	if !p.FooterRegion.IsEmpty() {
		fr := f.toReading(p.FooterRegion)
		if fr.Y0 > 0 && fr.Y0 < f.height {
			f.bodyBottom = fr.Y0
		}
	}
	if f.bodyBottom <= f.bodyTop {
		f.bodyTop = 0
		f.bodyBottom = f.height
	}
	return f
}

func (f pageFrame) toReading(r Rect) Rect {
	r = r.normalized()
	if f.topOrigin {
		return r
	}
	return Rect{
		X0: r.X0,
		Y0: f.height - r.Y1,
		X1: r.X1,
		Y1: f.height - r.Y0,
	}.normalized()
}

func rectIntersection(a, b Rect) Rect {
	a, b = a.normalized(), b.normalized()
	if a.X1 <= b.X0 || b.X1 <= a.X0 || a.Y1 <= b.Y0 || b.Y1 <= a.Y0 {
		return Rect{}
	}
	return Rect{
		X0: maxFloat(a.X0, b.X0),
		Y0: maxFloat(a.Y0, b.Y0),
		X1: minFloat(a.X1, b.X1),
		Y1: minFloat(a.Y1, b.Y1),
	}
}

func rectArea(r Rect) float64 {
	r = r.normalized()
	if r.IsEmpty() {
		return 0
	}
	return r.Width() * r.Height()
}

func overlapArea(a, b Rect) float64 {
	return rectArea(rectIntersection(a, b))
}

func isPageFurniture(cell Rect, region Rect) bool {
	if region.IsEmpty() {
		return false
	}
	cell = cell.normalized()
	region = region.normalized()
	if region.ContainsPoint(cell.CenterX(), cell.CenterY()) {
		return true
	}
	area := rectArea(cell)
	if area <= geometryEpsilon {
		return false
	}
	return overlapArea(cell, region)/area >= 0.60
}

type cellRef struct {
	cell       Cell
	reading    Rect
	page       int
	fragment   int
	sourceCell int
	column     int
	colSpan    int
}

type borderRef struct {
	line    Border
	reading Rect
}

type rowRef struct {
	cells  []*cellRef
	top    float64
	bottom float64
}

type columnBand struct {
	left  float64
	right float64
}

type fragment struct {
	pageIndex  int
	pageNumber int
	frame      pageFrame
	cells      []*cellRef
	borders    []borderRef
	rows       []*rowRef
	columns    []columnBand

	left   float64
	right  float64
	top    float64
	bottom float64

	headerRows     int
	headerSig      headerSignature
	explicitHeader bool

	index int
}

func buildFragments(page Page, pageIndex int, pageNumber int, opts Options, warnings *[]Warning) []*fragment {
	frame := makePageFrame(page, opts)
	var cells []*cellRef
	for i, c := range page.Cells {
		cellBounds := c.Bounds.normalized()
		if cellBounds.IsEmpty() {
			continue
		}
		if isPageFurniture(cellBounds, page.HeaderRegion) || isPageFurniture(cellBounds, page.FooterRegion) {
			continue
		}
		cells = append(cells, &cellRef{
			cell:       c,
			reading:    frame.toReading(cellBounds),
			page:       pageNumber,
			sourceCell: i,
		})
	}

	var borders []borderRef
	for _, b := range page.Borders {
		if math.Abs(b.X0-b.X1) <= geometryEpsilon && math.Abs(b.Y0-b.Y1) <= geometryEpsilon {
			continue
		}
		borders = append(borders, borderRef{
			line:    b,
			reading: frame.toReading(Rect{X0: b.X0, Y0: b.Y0, X1: b.X1, Y1: b.Y1}),
		})
	}

	if len(cells) == 0 {
		*warnings = append(*warnings, Warning{
			Code:    WarnInvalidPage,
			Page:    pageNumber,
			Message: "page has no table cells outside its header/footer regions",
		})
		return nil
	}

	groups := splitCellGroups(cells, opts)
	fragments := make([]*fragment, 0, len(groups))
	for i, group := range groups {
		f := &fragment{
			pageIndex:  pageIndex,
			pageNumber: pageNumber,
			frame:      frame,
			cells:      group,
			borders:    borders,
			index:      i,
		}
		f.recomputeExtent()
		f.columns = inferColumns(f)
		f.assignColumns()
		f.rows = buildRows(f)
		f.resolveHeader(opts)
		for _, c := range f.cells {
			c.fragment = i
		}
		fragments = append(fragments, f)
	}
	return fragments
}

func splitCellGroups(cells []*cellRef, opts Options) [][]*cellRef {
	if len(cells) == 0 {
		return nil
	}
	ordered := append([]*cellRef(nil), cells...)
	sortCellRefs(ordered)
	heights := make([]float64, 0, len(ordered))
	for _, c := range ordered {
		if c.cell.RowSpan <= 1 {
			heights = append(heights, c.reading.Height())
		}
	}
	if len(heights) == 0 {
		for _, c := range ordered {
			heights = append(heights, c.reading.Height())
		}
	}
	rowHeight := median(heights)
	if rowHeight <= geometryEpsilon {
		rowHeight = 1
	}
	gap := opts.FragmentGapRows * rowHeight
	if gap < 1 {
		gap = 1
	}

	var groups [][]*cellRef
	var current []*cellRef
	var bottom float64
	for _, c := range ordered {
		if len(current) == 0 {
			current = []*cellRef{c}
			bottom = c.reading.Y1
			continue
		}
		if c.reading.Y0-bottom > gap {
			groups = append(groups, current)
			current = []*cellRef{c}
			bottom = c.reading.Y1
			continue
		}
		current = append(current, c)
		bottom = maxFloat(bottom, c.reading.Y1)
	}
	if len(current) > 0 {
		groups = append(groups, current)
	}
	return groups
}

func sortCellRefs(cells []*cellRef) {
	// Insertion sort keeps the implementation deterministic without extra
	// dependencies; recognized tables are small compared with page content.
	for i := 1; i < len(cells); i++ {
		x := cells[i]
		j := i
		for j > 0 && lessCell(x, cells[j-1]) {
			cells[j] = cells[j-1]
			j--
		}
		cells[j] = x
	}
}

func lessCell(a, b *cellRef) bool {
	if a.reading.Y0 != b.reading.Y0 {
		return a.reading.Y0 < b.reading.Y0
	}
	if a.reading.X0 != b.reading.X0 {
		return a.reading.X0 < b.reading.X0
	}
	return a.sourceCell < b.sourceCell
}

func (f *fragment) recomputeExtent() {
	first := true
	for _, c := range f.cells {
		if first {
			f.left, f.right = c.reading.X0, c.reading.X1
			f.top, f.bottom = c.reading.Y0, c.reading.Y1
			first = false
			continue
		}
		f.left = minFloat(f.left, c.reading.X0)
		f.right = maxFloat(f.right, c.reading.X1)
		f.top = minFloat(f.top, c.reading.Y0)
		f.bottom = maxFloat(f.bottom, c.reading.Y1)
	}
}

func (f *fragment) height() float64 {
	return maxFloat(0, f.bottom-f.top)
}

func (f *fragment) width() float64 {
	return maxFloat(0, f.right-f.left)
}

func inferColumns(f *fragment) []columnBand {
	width := f.width()
	if width <= geometryEpsilon {
		width = 1
	}
	tolerance := maxFloat(1, 0.018*width)

	var values []float64
	if f.height() > geometryEpsilon {
		for _, b := range f.borders {
			r := b.reading.normalized()
			if absFloat(r.X1-r.X0) > tolerance {
				continue
			}
			if r.Y1-r.Y0 < 0.20*f.height() {
				continue
			}
			if r.CenterX() < f.left-tolerance || r.CenterX() > f.right+tolerance {
				continue
			}
			values = append(values, r.CenterX())
		}
	}

	for _, c := range f.cells {
		values = append(values, c.reading.X0, c.reading.X1)
	}
	values = append(values, f.left, f.right)
	values = clusterValues(values, tolerance)

	// Drop boundaries that would produce sliver columns caused by text-box
	// insets. The outer extent is always retained.
	cleaned := make([]float64, 0, len(values))
	minColumnWidth := maxFloat(1, 0.015*width)
	for _, x := range values {
		if len(cleaned) > 0 && x-cleaned[len(cleaned)-1] < minColumnWidth {
			continue
		}
		if x < f.left-tolerance || x > f.right+tolerance {
			continue
		}
		cleaned = append(cleaned, x)
	}
	if len(cleaned) == 0 {
		cleaned = []float64{f.left, f.right}
	}
	if cleaned[0] > f.left {
		cleaned = append([]float64{f.left}, cleaned...)
	}
	if cleaned[len(cleaned)-1] < f.right {
		cleaned = append(cleaned, f.right)
	}
	if len(cleaned) < 2 {
		cleaned = []float64{f.left, f.right}
	}

	columns := make([]columnBand, 0, len(cleaned)-1)
	for i := 0; i+1 < len(cleaned); i++ {
		left, right := cleaned[i], cleaned[i+1]
		if right-left <= geometryEpsilon {
			continue
		}
		columns = append(columns, columnBand{
			left:  left,
			right: right,
		})
	}
	if len(columns) == 0 {
		columns = []columnBand{{left: f.left, right: f.right}}
	}
	return columns
}

func clusterValues(values []float64, tolerance float64) []float64 {
	if len(values) == 0 {
		return nil
	}
	sortFloat64s(values)
	clusters := make([]float64, 0, len(values))
	var sum float64
	var count int
	var anchor float64
	flush := func() {
		if count > 0 {
			clusters = append(clusters, sum/float64(count))
		}
	}
	for _, v := range values {
		if count == 0 {
			anchor = v
			sum = v
			count = 1
			continue
		}
		if v-anchor <= tolerance {
			sum += v
			count++
			continue
		}
		flush()
		anchor = v
		sum = v
		count = 1
	}
	flush()
	return clusters
}

func (f *fragment) assignColumns() {
	for _, c := range f.cells {
		start, span := locateColumns(c.reading, f.columns)
		c.column = start
		c.colSpan = span
		if c.cell.ColSpan > span {
			span = c.cell.ColSpan
			if start+span > len(f.columns) {
				span = len(f.columns) - start
			}
			c.colSpan = span
		}
	}
}

func locateColumns(r Rect, columns []columnBand) (int, int) {
	if len(columns) <= 1 {
		return 0, maxInt(1, len(columns))
	}
	r = r.normalized()
	probeLeft := r.X0 + 0.25*r.Width()
	probeRight := r.X1 - 0.25*r.Width()
	start, end := -1, -1
	for i, col := range columns {
		if probeLeft >= col.left-geometryEpsilon && probeLeft <= col.right+geometryEpsilon {
			start = i
		}
		if probeRight >= col.left-geometryEpsilon && probeRight <= col.right+geometryEpsilon {
			end = i
		}
	}
	if start < 0 {
		center := r.CenterX()
		for i, col := range columns {
			if center >= col.left && center <= col.right {
				start = i
				break
			}
		}
	}
	if start < 0 {
		start = 0
	}
	if end < start {
		center := r.CenterX()
		end = start
		for i := start; i < len(columns); i++ {
			if center <= columns[i].right {
				end = i
				break
			}
		}
	}
	return start, end - start + 1
}

func buildRows(f *fragment) []*rowRef {
	ordered := append([]*cellRef(nil), f.cells...)
	sortCellRefs(ordered)
	heights := make([]float64, 0, len(ordered))
	for _, c := range ordered {
		if c.cell.RowSpan <= 1 {
			heights = append(heights, c.reading.Height())
		}
	}
	rowHeight := median(heights)
	if rowHeight <= geometryEpsilon {
		rowHeight = median(func() []float64 {
			out := make([]float64, 0, len(ordered))
			for _, c := range ordered {
				out = append(out, c.reading.Height())
			}
			return out
		}())
	}
	if rowHeight <= geometryEpsilon {
		rowHeight = 1
	}
	tolerance := 0.38 * rowHeight

	var rows []*rowRef
	for _, c := range ordered {
		var best *rowRef
		bestDistance := math.MaxFloat64
		for _, r := range rows {
			d := absFloat(c.reading.Y0 - r.top)
			if d <= tolerance && d < bestDistance {
				best = r
				bestDistance = d
			}
		}
		if best == nil {
			rows = append(rows, &rowRef{
				cells:  []*cellRef{c},
				top:    c.reading.Y0,
				bottom: c.reading.Y1,
			})
			continue
		}
		best.cells = append(best.cells, c)
		best.top = minFloat(best.top, c.reading.Y0)
		best.bottom = maxFloat(best.bottom, c.reading.Y1)
	}
	sortRows(rows)
	return rows
}

func sortRows(rows []*rowRef) {
	for i := 1; i < len(rows); i++ {
		x := rows[i]
		j := i
		for j > 0 && rows[j-1].top > x.top {
			rows[j] = rows[j-1]
			j--
		}
		rows[j] = x
	}
}

func (f *fragment) resolveHeader(opts Options) {
	f.headerRows = 0
	seenExplicit := false
	for i, r := range f.rows {
		rowHasHeader := false
		for _, c := range r.cells {
			if c.cell.Header {
				rowHasHeader = true
				seenExplicit = true
				break
			}
		}
		if rowHasHeader {
			f.headerRows = i + 1
			continue
		}
		if i == 0 && opts.AssumeFirstRowHeader {
			f.headerRows = 1
			continue
		}
		if seenExplicit {
			break
		}
		break
	}
	if f.headerRows == 0 && opts.AssumeFirstRowHeader && len(f.rows) > 0 {
		f.headerRows = 1
	}
	if f.headerRows > len(f.rows) {
		f.headerRows = len(f.rows)
	}
	f.explicitHeader = false
	for i := 0; i < f.headerRows; i++ {
		for _, c := range f.rows[i].cells {
			if c.cell.Header {
				f.explicitHeader = true
				break
			}
		}
	}
	f.headerSig = buildHeaderSignature(f.rows[:f.headerRows], len(f.columns))
}

func (f *fragment) dataRows() []*rowRef {
	if f.headerRows >= len(f.rows) {
		return nil
	}
	return f.rows[f.headerRows:]
}

func (f *fragment) headerRowRefs() []*rowRef {
	if f.headerRows <= 0 {
		return nil
	}
	return f.rows[:f.headerRows]
}

func (f *fragment) rowCoverage(r *rowRef) int {
	if r == nil {
		return 0
	}
	covered := make([]bool, len(f.columns))
	for _, c := range r.cells {
		for i := c.column; i < c.column+c.colSpan && i < len(covered); i++ {
			covered[i] = true
		}
	}
	n := 0
	for _, v := range covered {
		if v {
			n++
		}
	}
	return n
}
