package dataeng

import (
	"fmt"
	"testing"
)

const (
	testPageWidth  = 600.0
	testPageHeight = 800.0
	testHeaderEnd  = 50.0
	testFooterTop  = 760.0
)

func testPage(number int, cells []Cell, borders []Border) Page {
	return Page{
		Number:       number,
		Width:        testPageWidth,
		Height:       testPageHeight,
		Cells:        cells,
		Borders:      borders,
		HeaderRegion: Rect{X0: 0, Y0: 0, X1: testPageWidth, Y1: testHeaderEnd},
		FooterRegion: Rect{X0: 0, Y0: testFooterTop, X1: testPageWidth, Y1: testPageHeight},
	}
}

type gridSpec struct {
	number         int
	headerTop      float64
	rowHeight      float64
	columnWidths   []float64
	headers        []string
	headerSpans    []int
	headersAreData bool
	rows           [][]string
	bottomBorder   bool
	omitTopBorder  bool
}

func gridPage(spec gridSpec) Page {
	width := testPageWidth
	height := testPageHeight
	var lefts, boundaries []float64
	x := 40.0
	lefts = append(lefts, x)
	boundaries = append(boundaries, x)
	for _, w := range spec.columnWidths {
		x += w
		boundaries = append(boundaries, x)
		lefts = append(lefts, x)
	}
	tableRight := x

	var cells []Cell
	var borders []Border
	headerBottom := spec.headerTop + spec.rowHeight
	y := spec.headerTop
	col := 0
	for i, text := range spec.headers {
		span := 1
		if i < len(spec.headerSpans) && spec.headerSpans[i] > 1 {
			span = spec.headerSpans[i]
		}
		if col >= len(spec.columnWidths) {
			break
		}
		endCol := col + span
		if endCol > len(spec.columnWidths) {
			endCol = len(spec.columnWidths)
		}
		if text != "" {
			cells = append(cells, Cell{
				ID:      fmt.Sprintf("p%d-h%d", spec.number, i),
				Text:    text,
				Bounds:  Rect{X0: lefts[col], Y0: y, X1: lefts[endCol], Y1: headerBottom},
				Header:  !spec.headersAreData,
				ColSpan: endCol - col,
			})
		}
		col = endCol
	}

	if !spec.omitTopBorder {
		borders = append(borders,
			Border{X0: lefts[0], Y0: spec.headerTop, X1: tableRight, Y1: spec.headerTop})
	}
	borders = append(borders,
		Border{X0: lefts[0], Y0: headerBottom, X1: tableRight, Y1: headerBottom})

	for rowIndex, row := range spec.rows {
		y = headerBottom + float64(rowIndex)*spec.rowHeight
		for colIndex, text := range row {
			if text == "" || colIndex >= len(spec.columnWidths) {
				continue
			}
			cells = append(cells, Cell{
				ID:     fmt.Sprintf("p%d-r%d-c%d", spec.number, rowIndex, colIndex),
				Text:   text,
				Bounds: Rect{X0: lefts[colIndex], Y0: y, X1: lefts[colIndex+1], Y1: y + spec.rowHeight},
			})
		}
	}

	lastY := headerBottom + float64(len(spec.rows))*spec.rowHeight
	for _, bx := range boundaries {
		borders = append(borders, Border{X0: bx, Y0: spec.headerTop, X1: bx, Y1: lastY})
	}
	if spec.bottomBorder {
		borders = append(borders, Border{X0: lefts[0], Y0: lastY, X1: tableRight, Y1: lastY})
	}

	cells = append(cells,
		Cell{Text: "Monthly report", Bounds: Rect{X0: 30, Y0: 12, X1: 260, Y1: 38}},
		Cell{Text: fmt.Sprintf("Page %d", spec.number), Bounds: Rect{X0: 500, Y0: 770, X1: 570, Y1: 792}},
	)
	return Page{
		Number:       spec.number,
		Width:        width,
		Height:       height,
		Cells:        cells,
		Borders:      borders,
		HeaderRegion: Rect{X0: 0, Y0: 0, X1: width, Y1: testHeaderEnd},
		FooterRegion: Rect{X0: 0, Y0: testFooterTop, X1: width, Y1: height},
	}
}

func fullRows(count int) [][]string {
	rows := make([][]string, 0, count)
	for i := 0; i < count; i++ {
		rows = append(rows, []string{
			fmt.Sprintf("A%d", i+1),
			fmt.Sprintf("B%d", i+1),
			fmt.Sprintf("%d", (i+1)*10),
		})
	}
	return rows
}

func TestContinuationWithRepeatedHeaderKeepsHeaderSource(t *testing.T) {
	headers := []string{"Item", "Description", "Amount"}
	widths := []float64{160, 200, 160}
	p1 := gridPage(gridSpec{
		number:       1,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         fullRows(22),
		bottomBorder: true,
	})
	p2 := gridPage(gridSpec{
		number:       2,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         fullRows(2),
	})

	tables := Assemble([]Page{p1, p2})
	if len(tables) != 1 {
		t.Fatalf("got %d tables, want 1", len(tables))
	}
	table := tables[0]
	if got, want := len(table.Rows), 24; got != want {
		t.Fatalf("got %d data rows, want %d", got, want)
	}
	if got, want := len(table.HeaderOccurrences), 2; got != want {
		t.Fatalf("got %d header occurrences, want %d", got, want)
	}
	second := table.HeaderOccurrences[1]
	if !second.Removed || second.Source.Page != 2 {
		t.Fatalf("duplicate header provenance not preserved: %+v", second)
	}
	if len(second.Rows) != 1 || second.Rows[0].Cells[0].Text != "Item" {
		t.Fatalf("removed header cells were not retained: %+v", second.Rows)
	}
	if len(table.Boundaries) != 1 || !table.Boundaries[0].HeaderRemoved {
		t.Fatalf("boundary did not record header removal: %+v", table.Boundaries)
	}
	if len(table.Pages) != 2 || table.Pages[1].Page != 2 {
		t.Fatalf("page provenance missing: %+v", table.Pages)
	}
	for _, row := range table.Rows {
		for _, cell := range row.Cells {
			if cell.Text == "Monthly report" || cell.Text == "Page 2" {
				t.Fatalf("page furniture leaked into table: %+v", cell)
			}
		}
	}
}

func TestTableEndingMidPageIsNotContinued(t *testing.T) {
	headers := []string{"Code", "Name", "Value"}
	widths := []float64{120, 240, 160}
	p1 := gridPage(gridSpec{
		number:       1,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         fullRows(5),
	})
	p2 := gridPage(gridSpec{
		number:       2,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         fullRows(3),
	})

	tables := Assemble([]Page{p1, p2})
	if len(tables) != 2 {
		t.Fatalf("got %d tables, want 2: a table that closes in the middle of a page must not continue", len(tables))
	}
}

func TestDifferentColumnGeometrySplits(t *testing.T) {
	headers := []string{"Code", "Name", "Value"}
	p1 := gridPage(gridSpec{
		number:       1,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: []float64{120, 240, 160},
		headers:      headers,
		rows:         fullRows(22),
	})
	p2 := gridPage(gridSpec{
		number:       2,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: []float64{260, 260},
		headers:      []string{"Code", "Name"},
		rows:         fullRows(3),
	})

	tables := Assemble([]Page{p1, p2})
	if len(tables) != 2 {
		t.Fatalf("got %d tables, want 2", len(tables))
	}
}

func TestCrossPageRowFragmentsAreKeptSeparate(t *testing.T) {
	headers := []string{"Code", "Name", "Value"}
	widths := []float64{120, 240, 160}
	rows1 := fullRows(21)
	rows1 = append(rows1, []string{"LAST", "same-looking-tail", ""})
	p1 := gridPage(gridSpec{
		number:       1,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         rows1,
	})
	p2 := gridPage(gridSpec{
		number:         2,
		headerTop:      50,
		rowHeight:      30,
		columnWidths:   widths,
		headers:        []string{"", "", "same-looking-tail"},
		headerSpans:    []int{1, 1, 1},
		headersAreData: true,
		omitTopBorder:  true,
		rows:           fullRows(3),
	})

	tables := Assemble([]Page{p1, p2})
	if len(tables) != 1 {
		t.Fatalf("got %d tables, want 1", len(tables))
	}
	table := tables[0]
	if len(table.Boundaries) != 1 || !table.Boundaries[0].RowSplit {
		t.Fatalf("cross-page row was not recorded: %+v", table.Boundaries)
	}
	if got, want := len(table.Rows), 26; got != want {
		t.Fatalf("row fragments were unexpectedly merged: got %d rows, want %d", got, want)
	}
	if !table.Rows[21].Partial || !table.Rows[22].Partial {
		t.Fatalf("clipped row fragments were not marked partial: %+v / %+v", table.Rows[21], table.Rows[22])
	}
}

func TestCrossPageRowAfterRepeatedHeaderIsKeptSeparate(t *testing.T) {
	headers := []string{"Code", "Name", "Value"}
	widths := []float64{120, 240, 160}
	rows1 := fullRows(21)
	rows1 = append(rows1, []string{"LAST", "tail", ""})
	p1 := gridPage(gridSpec{
		number:       1,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         rows1,
	})
	rows2 := append([][]string{{"", "", "tail"}}, fullRows(3)...)
	p2 := gridPage(gridSpec{
		number:       2,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         rows2,
	})

	tables := Assemble([]Page{p1, p2})
	if len(tables) != 1 {
		t.Fatalf("got %d tables, want 1", len(tables))
	}
	table := tables[0]
	if len(table.Boundaries) != 1 || !table.Boundaries[0].RowSplit {
		t.Fatalf("cross-page row was not recorded: %+v", table.Boundaries)
	}
	if got, want := len(table.Rows), 26; got != want {
		t.Fatalf("got %d rows, want %d", got, want)
	}
	if !table.Rows[21].Partial || !table.Rows[22].Partial {
		t.Fatalf("clipped rows were not marked: %+v / %+v", table.Rows[21], table.Rows[22])
	}
	if len(table.HeaderOccurrences) != 2 || !table.HeaderOccurrences[1].Removed {
		t.Fatalf("repeated header was not removed: %+v", table.HeaderOccurrences)
	}
}

func TestMergedCellsArePreservedWithoutTextStitching(t *testing.T) {
	lefts := []float64{40, 200, 400, 560}
	cells := []Cell{
		{Text: "Item", Bounds: Rect{X0: lefts[0], Y0: 70, X1: lefts[2], Y1: 100}, Header: true, ColSpan: 2},
		{Text: "Qty", Bounds: Rect{X0: lefts[2], Y0: 70, X1: lefts[3], Y1: 100}, Header: true},
		{Text: "A", Bounds: Rect{X0: lefts[0], Y0: 100, X1: lefts[1], Y1: 130}},
		{Text: "B", Bounds: Rect{X0: lefts[1], Y0: 100, X1: lefts[2], Y1: 130}},
		{Text: "10", Bounds: Rect{X0: lefts[2], Y0: 100, X1: lefts[3], Y1: 130}},
		{Text: "MERGED", Bounds: Rect{X0: lefts[0], Y0: 130, X1: lefts[2], Y1: 190}, RowSpan: 2, ColSpan: 2},
		{Text: "20", Bounds: Rect{X0: lefts[2], Y0: 130, X1: lefts[3], Y1: 160}},
		{Text: "MERGED", Bounds: Rect{X0: lefts[2], Y0: 160, X1: lefts[3], Y1: 190}},
		{Text: "Report", Bounds: Rect{X0: 20, Y0: 10, X1: 200, Y1: 35}},
		{Text: "Page 1", Bounds: Rect{X0: 500, Y0: 770, X1: 570, Y1: 790}},
	}
	var borders []Border
	for _, x := range lefts {
		borders = append(borders, Border{X0: x, Y0: 70, X1: x, Y1: 190})
	}
	borders = append(borders,
		Border{X0: lefts[0], Y0: 70, X1: lefts[3], Y1: 70},
		Border{X0: lefts[0], Y0: 100, X1: lefts[3], Y1: 100},
	)

	table := Assemble([]Page{testPage(1, cells, borders)})[0]
	if got, want := len(table.Rows), 3; got != want {
		t.Fatalf("got %d rows, want %d", got, want)
	}
	merged := table.Rows[1].Cells[0]
	if merged.Text != "MERGED" || merged.ColSpan != 2 || merged.RowSpan != 2 {
		t.Fatalf("merged cell geometry was not preserved: %+v", merged)
	}
	if got, want := len(table.Rows[1].Cells), 2; got != want {
		t.Fatalf("merged cell was expanded into multiple cells: got %d cells, want %d", got, want)
	}
}

func TestBottomLeftOriginIsSupported(t *testing.T) {
	cells := []Cell{
		{Text: "Name", Bounds: Rect{X0: 40, Y0: 690, X1: 280, Y1: 720}, Header: true},
		{Text: "Value", Bounds: Rect{X0: 280, Y0: 690, X1: 560, Y1: 720}, Header: true},
		{Text: "first", Bounds: Rect{X0: 40, Y0: 660, X1: 280, Y1: 690}},
		{Text: "1", Bounds: Rect{X0: 280, Y0: 660, X1: 560, Y1: 690}},
		{Text: "second", Bounds: Rect{X0: 40, Y0: 630, X1: 280, Y1: 660}},
		{Text: "2", Bounds: Rect{X0: 280, Y0: 630, X1: 560, Y1: 660}},
		{Text: "Running head", Bounds: Rect{X0: 30, Y0: 755, X1: 250, Y1: 785}},
		{Text: "Page 1", Bounds: Rect{X0: 500, Y0: 10, X1: 570, Y1: 35}},
	}
	borders := []Border{
		{X0: 40, Y0: 690, X1: 560, Y1: 690},
		{X0: 40, Y0: 720, X1: 560, Y1: 720},
		{X0: 40, Y0: 630, X1: 40, Y1: 720},
		{X0: 280, Y0: 630, X1: 280, Y1: 720},
		{X0: 560, Y0: 630, X1: 560, Y1: 720},
	}
	page := Page{
		Number:       1,
		Width:        600,
		Height:       800,
		Cells:        cells,
		Borders:      borders,
		HeaderRegion: Rect{X0: 0, Y0: 740, X1: 600, Y1: 800},
		FooterRegion: Rect{X0: 0, Y0: 0, X1: 600, Y1: 45},
	}

	tables := Assemble([]Page{page})
	if len(tables) != 1 {
		t.Fatalf("got %d tables, want 1", len(tables))
	}
	table := tables[0]
	if got := table.Header[0].Cells[0].Text; got != "Name" {
		t.Fatalf("unexpected header order: %q", got)
	}
	if got := table.Rows[0].Cells[0].Text; got != "first" {
		t.Fatalf("unexpected first data row: %q", got)
	}
	if got := table.Rows[1].Cells[1].Text; got != "2" {
		t.Fatalf("unexpected second data row: %q", got)
	}
}

func TestAmbiguousContinuationFallsBackToSeparateTables(t *testing.T) {
	headers := []string{"Code", "Name", "Value"}
	widths := []float64{120, 240, 160}
	// Page 1 ends well above the footer, but the column frame happens to
	// match a completely unrelated table starting at the top of page 2.
	p1 := gridPage(gridSpec{
		number:       1,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      []string{"Code", "Name", "Value"},
		rows:         fullRows(4),
	})
	p2 := gridPage(gridSpec{
		number:       2,
		headerTop:    60,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         fullRows(4),
	})
	tables := Assemble([]Page{p1, p2}, WithMinConfidence(0.90))
	if len(tables) != 2 {
		t.Fatalf("got %d tables, want 2", len(tables))
	}
}

func TestEmptyInput(t *testing.T) {
	if got := Assemble(nil); got != nil {
		t.Fatalf("got %+v, want nil", got)
	}
}

func TestMultiRowHeaderIsRemovedAsOneBlock(t *testing.T) {
	lefts := []float64{40, 200, 400, 560}
	build := func(number int, dataRows int) Page {
		var cells []Cell
		cells = append(cells,
			Cell{Text: "Sales", Bounds: Rect{X0: lefts[0], Y0: 70, X1: lefts[3], Y1: 100}, Header: true, ColSpan: 3},
			Cell{Text: "Code", Bounds: Rect{X0: lefts[0], Y0: 100, X1: lefts[1], Y1: 130}, Header: true},
			Cell{Text: "Name", Bounds: Rect{X0: lefts[1], Y0: 100, X1: lefts[2], Y1: 130}, Header: true},
			Cell{Text: "Value", Bounds: Rect{X0: lefts[2], Y0: 100, X1: lefts[3], Y1: 130}, Header: true},
		)
		for i := 0; i < dataRows; i++ {
			y := 130.0 + float64(i)*30
			cells = append(cells,
				Cell{Text: fmt.Sprintf("C%d", i+1), Bounds: Rect{X0: lefts[0], Y0: y, X1: lefts[1], Y1: y + 30}},
				Cell{Text: fmt.Sprintf("N%d", i+1), Bounds: Rect{X0: lefts[1], Y0: y, X1: lefts[2], Y1: y + 30}},
				Cell{Text: fmt.Sprintf("%d", i+1), Bounds: Rect{X0: lefts[2], Y0: y, X1: lefts[3], Y1: y + 30}},
			)
		}
		last := 130.0 + float64(dataRows)*30
		var borders []Border
		for _, x := range lefts {
			borders = append(borders, Border{X0: x, Y0: 70, X1: x, Y1: last})
		}
		borders = append(borders,
			Border{X0: lefts[0], Y0: 70, X1: lefts[3], Y1: 70},
			Border{X0: lefts[0], Y0: 100, X1: lefts[3], Y1: 100},
			Border{X0: lefts[0], Y0: 130, X1: lefts[3], Y1: 130},
		)
		cells = append(cells, Cell{Text: "report head", Bounds: Rect{X0: 20, Y0: 10, X1: 200, Y1: 35}})
		return testPage(number, cells, borders)
	}

	p1 := build(1, 21)
	p2 := build(2, 2)
	tables := Assemble([]Page{p1, p2})
	if len(tables) != 1 {
		t.Fatalf("got %d tables, want 1", len(tables))
	}
	table := tables[0]
	if got, want := len(table.Header), 2; got != want {
		t.Fatalf("got %d header rows, want %d", got, want)
	}
	if got, want := len(table.Rows), 23; got != want {
		t.Fatalf("got %d data rows, want %d", got, want)
	}
	if got, want := len(table.HeaderOccurrences), 2; got != want {
		t.Fatalf("got %d header occurrences, want %d", got, want)
	}
	if !table.HeaderOccurrences[1].Removed || len(table.HeaderOccurrences[1].Rows) != 2 {
		t.Fatalf("multi-row duplicate header was not preserved: %+v", table.HeaderOccurrences[1])
	}
}

func TestMultipleFragmentsOnPageAndContinuationOfLast(t *testing.T) {
	headers := []string{"Code", "Name", "Value"}
	widths := []float64{120, 240, 160}
	first := gridPage(gridSpec{
		number:       1,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         fullRows(5),
	})
	second := gridPage(gridSpec{
		number:       1,
		headerTop:    400,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         fullRows(11),
	})
	// Combine the two page-one tables, keeping just one copy of the page
	// furniture cells.
	var cells []Cell
	for _, c := range first.Cells {
		if c.Bounds.CenterY() > testHeaderEnd && c.Bounds.CenterY() < testFooterTop {
			cells = append(cells, c)
		}
	}
	for _, c := range second.Cells {
		if c.Bounds.CenterY() > testHeaderEnd && c.Bounds.CenterY() < testFooterTop {
			cells = append(cells, c)
		}
	}
	cells = append(cells,
		Cell{Text: "report head", Bounds: Rect{X0: 20, Y0: 10, X1: 200, Y1: 35}},
		Cell{Text: "Page 1", Bounds: Rect{X0: 500, Y0: 770, X1: 570, Y1: 792}},
	)
	borders := append(append([]Border(nil), first.Borders...), second.Borders...)
	p1 := testPage(1, cells, borders)
	p2 := gridPage(gridSpec{
		number:       2,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         fullRows(2),
	})

	tables := Assemble([]Page{p1, p2})
	if got, want := len(tables), 2; got != want {
		t.Fatalf("got %d tables, want %d", got, want)
	}
	if got, want := len(tables[0].Rows), 5; got != want {
		t.Fatalf("first fragment has %d rows, want %d", got, want)
	}
	if got, want := len(tables[1].Rows), 13; got != want {
		t.Fatalf("continued last fragment has %d rows, want %d", got, want)
	}
	if got, want := len(tables[1].Pages), 2; got != want {
		t.Fatalf("continued last fragment has %d pages, want %d", got, want)
	}
}

func TestFullWidthHeaderPunctuationNormalizes(t *testing.T) {
	lefts := []float64{40, 300, 560}
	build := func(number int, dataRows int, secondHeader string) Page {
		cells := []Cell{
			{Text: "金额（元）", Bounds: Rect{X0: lefts[0], Y0: 70, X1: lefts[1], Y1: 100}, Header: true},
			{Text: secondHeader, Bounds: Rect{X0: lefts[1], Y0: 70, X1: lefts[2], Y1: 100}, Header: true},
		}
		for i := 0; i < dataRows; i++ {
			y := 100.0 + float64(i)*30
			cells = append(cells,
				Cell{Text: "x", Bounds: Rect{X0: lefts[0], Y0: y, X1: lefts[1], Y1: y + 30}},
				Cell{Text: "y", Bounds: Rect{X0: lefts[1], Y0: y, X1: lefts[2], Y1: y + 30}},
			)
		}
		last := 100.0 + float64(dataRows)*30
		var borders []Border
		for _, x := range lefts {
			borders = append(borders, Border{X0: x, Y0: 70, X1: x, Y1: last})
		}
		borders = append(borders,
			Border{X0: lefts[0], Y0: 70, X1: lefts[2], Y1: 70},
			Border{X0: lefts[0], Y0: 100, X1: lefts[2], Y1: 100},
		)
		return testPage(number, cells, borders)
	}

	p1 := build(1, 22, "占比：%")
	p2 := build(2, 2, "占比:%")
	tables := Assemble([]Page{p1, p2})
	if len(tables) != 1 {
		t.Fatalf("got %d tables, want 1", len(tables))
	}
	if len(tables[0].HeaderOccurrences) != 2 {
		t.Fatalf("normalized header was not treated as a duplicate: %+v", tables[0].HeaderOccurrences)
	}
}

func TestContinuationAcrossThreePages(t *testing.T) {
	headers := []string{"Code", "Name", "Value"}
	widths := []float64{120, 240, 160}
	p1 := gridPage(gridSpec{
		number:       1,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         fullRows(22),
	})
	p2 := gridPage(gridSpec{
		number:       2,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         fullRows(22),
	})
	p3 := gridPage(gridSpec{
		number:       3,
		headerTop:    70,
		rowHeight:    30,
		columnWidths: widths,
		headers:      headers,
		rows:         fullRows(2),
	})
	tables := Assemble([]Page{p1, p2, p3})
	if len(tables) != 1 {
		t.Fatalf("got %d tables, want 1", len(tables))
	}
	table := tables[0]
	if got, want := len(table.Rows), 46; got != want {
		t.Fatalf("got %d rows, want %d", got, want)
	}
	if got, want := len(table.Boundaries), 2; got != want {
		t.Fatalf("got %d boundaries, want %d", got, want)
	}
	if got, want := len(table.HeaderOccurrences), 3; got != want {
		t.Fatalf("got %d header occurrences, want %d", got, want)
	}
	if !table.HeaderOccurrences[1].Removed || !table.HeaderOccurrences[2].Removed {
		t.Fatalf("repeated headers were not removed: %+v", table.HeaderOccurrences)
	}
}
