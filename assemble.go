package dataeng

import (
	"fmt"
)

// Assemble groups page fragments into tables. It joins fragments across
// consecutive pages only when the evidence is strong; otherwise it starts a
// new table.
//
// The decision uses column geometry, the normalized table-header signature,
// and page-break evidence. Data-row text and cell text similarity are never
// used to stitch rows, merged cells, or page fragments.
func Assemble(pages []Page, opts ...Option) []Table {
	tables, _ := AssembleWithWarnings(pages, opts...)
	return tables
}

// AssembleTables is an alias for Assemble.
func AssembleTables(pages []Page, opts ...Option) []Table {
	return Assemble(pages, opts...)
}

// AssembleWithWarnings is Assemble plus page-level warnings that cannot be
// attached to a table, such as an empty page.
func AssembleWithWarnings(pages []Page, opts ...Option) ([]Table, []Warning) {
	options := applyOptions(opts)
	if len(pages) == 0 {
		return nil, nil
	}

	numbers := make([]int, len(pages))
	for i, p := range pages {
		if p.Number > 0 {
			numbers[i] = p.Number
		} else {
			numbers[i] = i + 1
		}
	}

	var globalWarnings []Warning
	allFragments := make([][]*fragment, len(pages))
	for i, p := range pages {
		allFragments[i] = buildFragments(p, i, numbers[i], options, &globalWarnings)
	}

	type build struct {
		table    *Table
		lastFrag *fragment
	}
	var builds []*build
	tableSeq := 0

	for pageIndex, fragments := range allFragments {
		for fragmentIndex, frag := range fragments {
			var previous *build
			if fragmentIndex == 0 && len(builds) > 0 {
				last := builds[len(builds)-1]
				if last.lastFrag != nil &&
					last.lastFrag.pageIndex == pageIndex-1 &&
					numbers[pageIndex] == numbers[pageIndex-1]+1 {
					previous = last
				}
			}

			if previous != nil {
				decision := decideMatch(previous.lastFrag, frag, options)
				if decision.join {
					appendFragmentToTable(previous.table, previous.lastFrag, frag, decision)
					previous.lastFrag = frag
					continue
				}
				if decision.ambiguous {
					previous.table.Warnings = append(previous.table.Warnings, Warning{
						Code: WarnAmbiguousBreak,
						Page: numbers[pageIndex],
						Message: fmt.Sprintf(
							"page break kept as separate tables: column %.2f, header %.2f, break %.2f, confidence %.2f",
							decision.columnScore, decision.headerScore,
							decision.breakScore, decision.confidence),
					})
				}
			}

			tableSeq++
			table := newTableFromFragment(frag, tableSeq)
			builds = append(builds, &build{table: table, lastFrag: frag})
		}
	}

	out := make([]Table, 0, len(builds))
	for _, b := range builds {
		finalizeTable(b.table)
		out = append(out, *b.table)
	}
	return out, globalWarnings
}

type matchDecision struct {
	join          bool
	ambiguous     bool
	columnScore   float64
	headerScore   float64
	breakScore    float64
	confidence    float64
	headerRemoved bool
}

func decideMatch(a, b *fragment, opts Options) matchDecision {
	d := matchDecision{}
	d.columnScore = compareColumns(a, b, opts)
	d.headerScore = headerSimilarity(a.headerSig, b.headerSig)
	headerMatch := d.headerScore >= opts.HeaderSimilarity &&
		a.headerSig.nonEmpty > 0 && b.headerSig.nonEmpty > 0
	d.breakScore = breakEvidence(a, b, opts, headerMatch)

	if d.columnScore <= 0.01 {
		d.ambiguous = false
		return d
	}
	// An explicitly marked, different header almost always starts a new
	// table. Do not let a coincidental edge alignment override that evidence.
	if b.explicitHeader && !headerMatch {
		d.ambiguous = d.breakScore >= 0.5
		return d
	}

	switch {
	case headerMatch && d.columnScore >= 0.72 && d.breakScore >= 0.25:
		d.join = true
		d.headerRemoved = b.headerRows > 0
	case !headerMatch && d.breakScore >= 0.88 && d.columnScore >= 0.88:
		d.join = true
	}

	if d.join {
		switch {
		case headerMatch:
			d.confidence = 0.50*d.columnScore + 0.35*d.headerScore + 0.15*d.breakScore
		default:
			d.confidence = 0.60*d.columnScore + 0.40*d.breakScore
		}
		if d.confidence < opts.MinConfidence {
			d.join = false
		}
	}
	d.ambiguous = !d.join && (d.columnScore >= 0.65 &&
		(d.headerScore >= 0.65 || d.breakScore >= 0.45))
	return d
}

func compareColumns(a, b *fragment, opts Options) float64 {
	if len(a.columns) == 0 || len(b.columns) == 0 {
		return 0
	}
	if len(a.columns) != len(b.columns) {
		return 0
	}
	if a.width() <= geometryEpsilon || b.width() <= geometryEpsilon {
		return 0
	}
	aBounds := columnBoundaries(a)
	bBounds := columnBoundaries(b)
	var diffs []float64
	for i := range aBounds {
		diffs = append(diffs, absFloat(aBounds[i]-bBounds[i]))
	}
	meanDiff := mean(diffs)
	boundaryScore := clamp01(1 - meanDiff/opts.ColumnTolerance)

	pageWidthA := maxFloat(a.frame.width, 1)
	pageWidthB := maxFloat(b.frame.width, 1)
	widthA := a.width() / pageWidthA
	widthB := b.width() / pageWidthB
	widthScore := clamp01(1 - absFloat(widthA-widthB)/(1.5*opts.ColumnTolerance))
	leftA := a.left / pageWidthA
	leftB := b.left / pageWidthB
	leftScore := clamp01(1 - absFloat(leftA-leftB)/(1.8*opts.ColumnTolerance))

	return clamp01(0.70*boundaryScore + 0.18*widthScore + 0.12*leftScore)
}

func columnBoundaries(f *fragment) []float64 {
	if len(f.columns) == 0 {
		return nil
	}
	width := f.width()
	if width <= geometryEpsilon {
		width = 1
	}
	out := make([]float64, 0, len(f.columns)+1)
	for _, c := range f.columns {
		out = append(out, (c.left-f.left)/width)
	}
	out = append(out, (f.columns[len(f.columns)-1].right-f.left)/width)
	return out
}

func breakEvidence(a, b *fragment, opts Options, headerMatch bool) float64 {
	tolA := maxFloat(4, opts.BreakTolerance*a.frame.height)
	tolB := maxFloat(4, opts.BreakTolerance*b.frame.height)
	gapA := maxFloat(0, a.frame.bodyBottom-a.bottom)
	gapB := maxFloat(0, b.top-b.frame.bodyTop)
	edgeA := clamp01(1 - gapA/tolA)
	edgeB := clamp01(1 - gapB/tolB)
	// A continuation needs clipping evidence at both sides of the physical
	// page break. Averaging alone would let a table that ends halfway down one
	// page join a fresh table at the top of the next.
	score := 0.75*minFloat(edgeA, edgeB) + 0.25*(edgeA+edgeB)/2

	lastComplete := a.rowCoverage(lastRow(a)) >= len(a.columns)
	firstComplete := b.rowCoverage(firstRow(b)) >= len(b.columns)
	// A rule exactly on the page-body edge is likely a page frame. Only treat
	// a horizontal rule slightly inside the body as table-closing evidence.
	if hasHorizontalBorderNear(a, a.bottom, tolA/3) && lastComplete &&
		gapA > maxFloat(2, 0.15*tolA) {
		score *= 0.30
	}
	if hasHorizontalBorderNear(b, b.top, tolB/3) && !headerMatch {
		score *= 0.75
	}
	if !lastComplete && edgeA >= 0.5 {
		score += 0.08
	}
	if !firstComplete && edgeB >= 0.5 {
		score += 0.08
	}
	return clamp01(score)
}

func lastRow(f *fragment) *rowRef {
	if len(f.rows) > 0 {
		return f.rows[len(f.rows)-1]
	}
	return nil
}

func firstRow(f *fragment) *rowRef {
	if len(f.rows) > 0 {
		return f.rows[0]
	}
	return nil
}

func hasHorizontalBorderNear(f *fragment, y, tolerance float64) bool {
	for _, b := range f.borders {
		r := b.reading.normalized()
		if r.Y1-r.Y0 > tolerance {
			continue
		}
		cy := r.CenterY()
		if absFloat(cy-y) > tolerance {
			continue
		}
		if r.X1 < f.left-tolerance || r.X0 > f.right+tolerance {
			continue
		}
		return true
	}
	return false
}

func newTableFromFragment(f *fragment, seq int) *Table {
	t := &Table{
		ID:         fmt.Sprintf("table-%d", seq),
		Columns:    outputColumns(f),
		Confidence: 1,
	}
	occurrence, _ := headerOccurrenceAndRows(f, true, false)
	t.Header = occurrence.Rows
	t.HeaderOccurrences = append(t.HeaderOccurrences, occurrence)
	if occurrence.Inferred {
		t.Warnings = append(t.Warnings, Warning{
			Code:    WarnInferredHeader,
			Page:    f.pageNumber,
			Message: "header was inferred from the leading row; no header flag was supplied",
		})
	}
	t.Rows = append(t.Rows, outputDataRows(f, true)...)
	t.Pages = append(t.Pages, PageRef{
		Page:         f.pageNumber,
		Fragment:     f.index,
		FirstDataRow: 0,
		LastDataRow:  len(t.Rows) - 1,
	})
	return t
}

func appendFragmentToTable(t *Table, a, b *fragment, d matchDecision) {
	headerRemoved := false
	var bRows []Row
	if d.headerRemoved {
		occurrence, _ := headerOccurrenceAndRows(b, false, true)
		t.HeaderOccurrences = append(t.HeaderOccurrences, occurrence)
		bRows = outputDataRows(b, d.headerRemoved)
		headerRemoved = true
	} else {
		bRows = outputDataRows(b, false)
	}

	firstData := len(t.Rows)
	t.Rows = append(t.Rows, bRows...)
	lastData := len(t.Rows) - 1
	pageRef := PageRef{
		Page:          b.pageNumber,
		Fragment:      b.index,
		HeaderRemoved: headerRemoved,
		FirstDataRow:  firstData,
		LastDataRow:   lastData,
	}
	if len(bRows) == 0 {
		pageRef.FirstDataRow = -1
		pageRef.LastDataRow = -1
	}
	t.Pages = append(t.Pages, pageRef)

	rowSplit := detectRowSplit(a, b, d.headerRemoved)
	if rowSplit {
		if len(t.Rows) > 0 {
			lastAIndex := firstData - 1
			if lastAIndex >= 0 {
				t.Rows[lastAIndex].Partial = true
			}
			if firstData <= lastData && firstData >= 0 {
				t.Rows[firstData].Partial = true
			}
		}
		t.Warnings = append(t.Warnings, Warning{
			Code:    WarnCrossPageRow,
			Page:    b.pageNumber,
			Message: "row appears clipped across the page break; row fragments were kept separate",
		})
	}

	t.Boundaries = append(t.Boundaries, PageBoundary{
		FromPage:      a.pageNumber,
		ToPage:        b.pageNumber,
		FromFragment:  a.index,
		ToFragment:    b.index,
		ColumnScore:   d.columnScore,
		HeaderScore:   d.headerScore,
		BreakScore:    d.breakScore,
		Confidence:    d.confidence,
		HeaderRemoved: headerRemoved,
		RowSplit:      rowSplit,
	})
	if d.confidence < t.Confidence {
		t.Confidence = d.confidence
	}
}

func detectRowSplit(a, b *fragment, headerRemoved bool) bool {
	last := lastRow(a)
	first := firstRow(b)
	firstEdge := b.frame.bodyTop
	if headerRemoved && b.headerRows > 0 {
		data := b.dataRows()
		if len(data) == 0 {
			return false
		}
		first = data[0]
		firstEdge = b.rows[b.headerRows-1].bottom
	}
	if last == nil || first == nil {
		return false
	}
	tolA := maxFloat(4, 0.06*a.frame.height)
	tolB := maxFloat(4, 0.06*b.frame.height)
	edgeA := a.frame.bodyBottom-last.bottom <= tolA
	edgeB := first.top-firstEdge <= tolB
	if !edgeA || !edgeB {
		return false
	}
	incompleteA := a.rowCoverage(last) < len(a.columns)
	incompleteB := b.rowCoverage(first) < len(b.columns)
	if incompleteA && incompleteB {
		return true
	}
	return false
}

func headerOccurrenceAndRows(f *fragment, canonical, removed bool) (HeaderOccurrence, []Row) {
	rows := make([]Row, 0, f.headerRows)
	source := RowSource{Page: f.pageNumber, Fragment: f.index}
	for i, r := range f.headerRowRefs() {
		rows = append(rows, outputRow(r, f, i, source, false, true))
	}
	return HeaderOccurrence{
		Source:    source,
		Rows:      rows,
		Canonical: canonical,
		Removed:   removed,
		Inferred:  !f.explicitHeader,
		Signature: f.headerSig.text,
	}, rows
}

func outputDataRows(f *fragment, headerRemoved bool) []Row {
	start := 0
	if headerRemoved {
		start = f.headerRows
	}
	rows := f.rows[start:]
	out := make([]Row, 0, len(rows))
	source := RowSource{Page: f.pageNumber, Fragment: f.index}
	for _, r := range rows {
		partial := rowLooksPartial(r, f)
		out = append(out, outputRow(r, f, -1, source, partial, false))
	}
	return out
}

func rowLooksPartial(r *rowRef, f *fragment) bool {
	if r == nil {
		return false
	}
	tol := maxFloat(3, 0.06*f.frame.height)
	nearTop := r.top-f.frame.bodyTop <= tol
	nearBottom := f.frame.bodyBottom-r.bottom <= tol
	if (nearTop || nearBottom) && f.rowCoverage(r) < len(f.columns) {
		return true
	}
	return false
}

func outputRow(r *rowRef, f *fragment, index int, source RowSource, partial, header bool) Row {
	cells := make([]Cell, 0, len(r.cells))
	ordered := append([]*cellRef(nil), r.cells...)
	sortCellRefs(ordered)
	for _, c := range ordered {
		cell := c.cell
		cell.Bounds = cell.Bounds.normalized()
		cell.Column = c.column
		cell.Row = index
		cell.Source = CellSource{
			Page:     f.pageNumber,
			Fragment: f.index,
			Header:   header,
		}
		if cell.RowSpan <= 0 {
			cell.RowSpan = 1
		}
		if c.colSpan > 0 {
			cell.ColSpan = c.colSpan
		} else if cell.ColSpan <= 0 {
			cell.ColSpan = 1
		}
		cells = append(cells, cell)
	}
	return Row{
		Index:   index,
		Cells:   cells,
		Source:  source,
		Partial: partial,
	}
}

func outputColumns(f *fragment) []Column {
	width := f.frame.width
	if width <= geometryEpsilon {
		width = maxFloat(f.width(), 1)
	}
	out := make([]Column, 0, len(f.columns))
	for i, c := range f.columns {
		left := (c.left - f.left) / maxFloat(f.width(), 1)
		right := (c.right - f.left) / maxFloat(f.width(), 1)
		out = append(out, Column{
			Index: i,
			Left:  left,
			Right: right,
			Width: right - left,
		})
	}
	return out
}

func finalizeTable(t *Table) {
	for i := range t.Rows {
		t.Rows[i].Index = i
		for j := range t.Rows[i].Cells {
			t.Rows[i].Cells[j].Row = i
		}
	}
	// Header rows are not part of Rows, but their cells still carry a useful
	// grid row number from the canonical page.
	for i := range t.Header {
		t.Header[i].Index = i
		for j := range t.Header[i].Cells {
			t.Header[i].Cells[j].Row = i
		}
	}
	if t.Confidence <= 0 {
		t.Confidence = 1
	}
}
