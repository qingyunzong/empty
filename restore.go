package dataeng

import (
	"fmt"
	"regexp"
	"sort"
)

// Formula is the parsed formula object attached to a worksheet cell.
//
// Type is "", "normal" or "shared"; any other value rejects the whole
// sheet. SI is the shared-formula identifier and is required exactly for
// Type == "shared". Ref is the master rectangle A1 reference and Text is
// the formula text. For shared cells, a non-empty Text together with Ref
// marks the master; a slave's own Text is ignored.
type Formula struct {
	Text string
	Type string
	SI   *uint32
	Ref  string
}

// Cell is one parsed worksheet cell. Coord is an uppercase A1 coordinate
// without leading-zero row numbers. A nil Formula represents a plain value
// cell, which never participates in restoration.
type Cell struct {
	Coord   string
	Formula *Formula
}

// RestoredFormula is the restored formula of one formula cell, ordered by
// row and then column in the Restore result.
type RestoredFormula struct {
	Coord    string
	Text     string
	Master   bool
	MasterSI uint32
	Changes  []RefChange
}

var coordRe = regexp.MustCompile(`^([A-Z]{1,3})([1-9][0-9]{0,6})$`)

// parseCoordinate validates an uppercase A1 coordinate and returns its
// 1-based row and column.
func parseCoordinate(coord string) (row, col int, err error) {
	m := coordRe.FindStringSubmatch(coord)
	if m == nil {
		return 0, 0, fmt.Errorf("dataeng: invalid cell coordinate %q", coord)
	}
	col, ok := lettersToCol(m[1])
	if !ok {
		return 0, 0, fmt.Errorf("dataeng: column out of range in %q", coord)
	}
	row = 0
	for i := 0; i < len(m[2]); i++ {
		row = row*10 + int(m[2][i]-'0')
	}
	if row > maxRow {
		return 0, 0, fmt.Errorf("dataeng: row out of range in %q", coord)
	}
	return row, col, nil
}

type rectangle struct {
	name           string
	si             uint32
	minRow, maxRow int
	minCol, maxCol int
}

func (r rectangle) contains(row, col int) bool {
	return r.minRow <= row && row <= r.maxRow && r.minCol <= col && col <= r.maxCol
}

func rectanglesOverlap(a, b rectangle) bool {
	return !(a.maxRow < b.minRow || b.maxRow < a.minRow ||
		a.maxCol < b.minCol || b.maxCol < a.minCol)
}

// parseRectangle parses a master Ref: either one A1 cell or an A1:B2 range.
func parseRectangle(ref string, si uint32) (rectangle, error) {
	first := ref
	second := ""
	for i := 0; i < len(ref); i++ {
		if ref[i] == ':' {
			first = ref[:i]
			second = ref[i+1:]
			break
		}
	}
	row1, col1, err := parseCoordinate(first)
	if err != nil {
		return rectangle{}, fmt.Errorf("dataeng: invalid master ref %q: %w", ref, err)
	}
	rect := rectangle{
		name:   ref,
		si:     si,
		minRow: row1, maxRow: row1,
		minCol: col1, maxCol: col1,
	}
	if second != "" {
		row2, col2, err := parseCoordinate(second)
		if err != nil {
			return rectangle{}, fmt.Errorf("dataeng: invalid master ref %q: %w", ref, err)
		}
		if row2 < rect.minRow {
			rect.minRow = row2
		}
		if row2 > rect.maxRow {
			rect.maxRow = row2
		}
		if col2 < rect.minCol {
			rect.minCol = col2
		}
		if col2 > rect.maxCol {
			rect.maxCol = col2
		}
	}
	return rect, nil
}

type indexedCell struct {
	row  int
	col  int
	cell Cell
}

// Restore rebuilds the real formula of every formula cell in one
// worksheet. Master shared formulas are kept verbatim; slave shared
// formulas are reconstructed from their master by translating relative A1
// references with the master-to-slave row/column offset. Normal and default
// formulas are kept verbatim even when they sit inside a shared rectangle.
// The whole sheet is rejected on unknown formula types, bad coordinates,
// duplicate cells, missing or duplicated masters, bad shared identifiers,
// slaves outside their master rectangle or overlapping master rectangles.
// Input order is arbitrary; the output is ordered by row then column.
func Restore(cells []Cell) ([]RestoredFormula, error) {
	indexed := make([]indexedCell, 0, len(cells))
	seen := make(map[string]bool, len(cells))
	for _, cell := range cells {
		row, col, err := parseCoordinate(cell.Coord)
		if err != nil {
			return nil, err
		}
		if seen[cell.Coord] {
			return nil, fmt.Errorf("dataeng: duplicate cell %q", cell.Coord)
		}
		seen[cell.Coord] = true
		indexed = append(indexed, indexedCell{
			row:  row,
			col:  col,
			cell: cell,
		})
	}

	type masterInfo struct {
		si    uint32
		coord string
		row   int
		col   int
		text  string
		rect  rectangle
	}
	masters := make(map[uint32]masterInfo)
	type slaveInfo struct {
		coord string
		row   int
		col   int
		si    uint32
	}
	var slaves []slaveInfo
	var normal []indexedCell

	for _, item := range indexed {
		formula := item.cell.Formula
		if formula == nil {
			continue
		}
		switch formula.Type {
		case "", "normal":
			if formula.Text == "" {
				return nil, fmt.Errorf("dataeng: cell %q requires non-empty formula text", item.cell.Coord)
			}
			if formula.SI != nil {
				return nil, fmt.Errorf("dataeng: non-shared cell %q must not carry si", item.cell.Coord)
			}
			if formula.Ref != "" {
				return nil, fmt.Errorf("dataeng: non-shared cell %q must not carry ref", item.cell.Coord)
			}
			normal = append(normal, item)
		case "shared":
			if formula.SI == nil {
				return nil, fmt.Errorf("dataeng: shared cell %q is missing si", item.cell.Coord)
			}
			si := *formula.SI
			if formula.Ref != "" {
				if formula.Text == "" {
					return nil, fmt.Errorf("dataeng: master cell %q requires non-empty formula text", item.cell.Coord)
				}
				rect, err := parseRectangle(formula.Ref, si)
				if err != nil {
					return nil, err
				}
				if !rect.contains(item.row, item.col) {
					return nil, fmt.Errorf("dataeng: master cell %q is outside its ref %q", item.cell.Coord, formula.Ref)
				}
				if existing, ok := masters[si]; ok {
					return nil, fmt.Errorf("dataeng: duplicate master %d at %q and %q", si, existing.coord, item.cell.Coord)
				}
				masters[si] = masterInfo{
					si:    si,
					coord: item.cell.Coord,
					row:   item.row,
					col:   item.col,
					text:  formula.Text,
					rect:  rect,
				}
			} else {
				slaves = append(slaves, slaveInfo{
					coord: item.cell.Coord,
					row:   item.row,
					col:   item.col,
					si:    si,
				})
			}
		default:
			return nil, fmt.Errorf("dataeng: unsupported formula type %q in cell %q", formula.Type, item.cell.Coord)
		}
	}

	masterList := make([]masterInfo, 0, len(masters))
	for _, master := range masters {
		masterList = append(masterList, master)
	}
	sort.Slice(masterList, func(i, j int) bool {
		if masterList[i].si != masterList[j].si {
			return masterList[i].si < masterList[j].si
		}
		return masterList[i].coord < masterList[j].coord
	})
	for i := 0; i < len(masterList); i++ {
		for j := i + 1; j < len(masterList); j++ {
			if rectanglesOverlap(masterList[i].rect, masterList[j].rect) {
				return nil, fmt.Errorf("dataeng: shared rectangles for si %d and %d overlap",
					masterList[i].si, masterList[j].si)
			}
		}
	}

	results := make([]RestoredFormula, 0, len(normal)+len(masterList)+len(slaves))

	for _, master := range masterList {
		results = append(results, RestoredFormula{
			Coord:    master.coord,
			Text:     master.text,
			Master:   true,
			MasterSI: master.si,
		})
	}

	for _, item := range normal {
		results = append(results, RestoredFormula{
			Coord: item.cell.Coord,
			Text:  item.cell.Formula.Text,
		})
	}

	for _, slave := range slaves {
		master, ok := masters[slave.si]
		if !ok {
			return nil, fmt.Errorf("dataeng: slave cell %q references missing master si %d", slave.coord, slave.si)
		}
		if !master.rect.contains(slave.row, slave.col) {
			return nil, fmt.Errorf("dataeng: slave cell %q is outside ref %q of master si %d",
				slave.coord, master.rect.name, slave.si)
		}
		rowDelta := slave.row - master.row
		colDelta := slave.col - master.col
		text, changes, err := ShiftFormula(master.text, rowDelta, colDelta)
		if err != nil {
			return nil, fmt.Errorf("dataeng: cannot restore cell %q from master si %d: %w",
				slave.coord, slave.si, err)
		}
		results = append(results, RestoredFormula{
			Coord:    slave.coord,
			Text:     text,
			MasterSI: slave.si,
			Changes:  changes,
		})
	}

	sort.Slice(results, func(i, j int) bool {
		ri, ci, _ := parseCoordinate(results[i].Coord)
		rj, cj, _ := parseCoordinate(results[j].Coord)
		if ri != rj {
			return ri < rj
		}
		return ci < cj
	})
	return results, nil
}
