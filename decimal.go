// Package dataeng infers a unified exact decimal column schema across
// multiple import batches.
//
// A cell is either null (the empty string) or a decimal string matching
// an optional leading minus sign, at least one integer digit, and an
// optional fractional part introduced by a decimal point followed by at
// least one digit. Exponents and whitespace are not accepted.
package dataeng

import (
	"errors"
	"fmt"
	"math/big"
	"regexp"
	"strings"
)

// NullCell is the only accepted representation of a null cell.
const NullCell = ""

var (
	// ErrLimitExceeded is wrapped by LimitError when a batch would push
	// the unified precision beyond the configured limit.
	ErrLimitExceeded = errors.New("dataeng: unified precision exceeds limit")
	// ErrInvalidCell is wrapped by CellError when a cell violates the
	// decimal syntax.
	ErrInvalidCell = errors.New("dataeng: invalid decimal cell")
)

var cellPattern = regexp.MustCompile(`^-?[0-9]+(?:\.[0-9]+)?$`)

// Schema describes the inferred decimal column mode. The zero value is
// only valid alongside a false Defined flag.
type Schema struct {
	// Precision is the maximum integer significant-digit count plus the
	// unified scale.
	Precision int
	// Scale is the maximum fractional-digit count across every
	// non-null value.
	Scale int
	// Defined reports whether at least one non-null value has been
	// accepted. An all-null column has no defined schema.
	Defined bool
}

// Row is one cell rendered through a view: Value is the arbitrary
// precision signed integer equal to the cell's numeric value multiplied
// by 10 to the view's Scale; OriginalScale is the cell's own
// fractional-digit count. A null row has a nil Value.
type Row struct {
	Value         *big.Int
	OriginalScale int
}

// LimitError reports that a batch was rejected because the inferred
// unified precision would exceed the column's precision limit.
type LimitError struct {
	// Limit is the caller-supplied maximum precision.
	Limit int
	// ProposedPrecision is the precision that the batch would have
	// produced.
	ProposedPrecision int
}

func (e *LimitError) Error() string {
	return fmt.Sprintf("dataeng: precision %d exceeds limit %d", e.ProposedPrecision, e.Limit)
}

func (e *LimitError) Unwrap() error { return ErrLimitExceeded }

// CellError reports a malformed cell inside a rejected batch.
type CellError struct {
	// Row is the zero-based position of the bad cell within the batch.
	Row int
	// Cell is the offending input.
	Cell string
}

func (e *CellError) Error() string {
	return fmt.Sprintf("dataeng: invalid decimal cell at row %d: %q", e.Row, e.Cell)
}

func (e *CellError) Unwrap() error { return ErrInvalidCell }

// parsedCell is a validated cell in its original scale.
type parsedCell struct {
	// digits is the signed integer obtained by removing the decimal
	// point; negative zero is stored as zero.
	digits *big.Int
	// intDigits is the count of significant integer digits after
	// leading zeros are stripped.
	intDigits int
	// scale is the number of fractional digits.
	scale int
	// null marks an absent value.
	null bool
}

// ParseCell validates and parses one cell. NullCell yields a null cell.
func ParseCell(cell string) (parsed parsedCell, err error) {
	if cell == NullCell {
		return parsedCell{null: true}, nil
	}
	if !cellPattern.MatchString(cell) {
		return parsedCell{}, ErrInvalidCell
	}

	negative := false
	body := cell
	if body[0] == '-' {
		negative = true
		body = body[1:]
	}

	intPart := body
	fracPart := ""
	if dot := strings.IndexByte(body, '.'); dot >= 0 {
		intPart = body[:dot]
		fracPart = body[dot+1:]
	}

	intPart = trimLeadingZeros(intPart)
	intDigits := len(intPart)

	combined := intPart + fracPart
	digits, ok := new(big.Int).SetString(combined, 10)
	if !ok {
		return parsedCell{}, ErrInvalidCell
	}
	if negative && digits.Sign() != 0 {
		digits.Neg(digits)
	}

	return parsedCell{
		digits:    digits,
		intDigits: intDigits,
		scale:     len(fracPart),
	}, nil
}

// FormatDecimal renders value as a canonical decimal string with the
// given fractional scale. Trailing fractional zeros are preserved and
// negative zero renders as plain zero.
func FormatDecimal(value *big.Int, scale int) string {
	if value == nil {
		panic("dataeng: FormatDecimal requires a non-nil value")
	}
	if scale < 0 {
		panic("dataeng: FormatDecimal requires a non-negative scale")
	}

	negative := value.Sign() < 0
	digits := value
	if negative {
		digits = new(big.Int).Neg(value)
	}
	whole := digits.String()

	if scale == 0 {
		if negative {
			return "-" + whole
		}
		return whole
	}

	whole = padLeft(whole, scale+1, '0')
	intPart := whole[:len(whole)-scale]
	fracPart := whole[len(whole)-scale:]
	result := intPart + "." + fracPart
	if negative {
		result = "-" + result
	}
	return result
}

// storedRow keeps an accepted cell in its original scale.
type storedRow struct {
	digits *big.Int
	scale  int
	null   bool
}

// Column accumulates batches and tracks the inferred unified schema.
// A Column is not safe for concurrent use.
type Column struct {
	limit     int
	rows      []storedRow
	scale     int
	maxIntDig int
	hasValue  bool
	view      *View
}

// NewColumn creates a column whose unified precision must never exceed
// maxPrecision. A non-positive limit panics.
func NewColumn(maxPrecision int) *Column {
	if maxPrecision <= 0 {
		panic("dataeng: maxPrecision must be positive")
	}
	return &Column{limit: maxPrecision}
}

// AppendBatch validates a whole batch and either commits every cell or
// rejects the entire batch without changing prior state. It returns the
// current view after a successful commit.
func (c *Column) AppendBatch(cells []string) (*View, error) {
	parsed := make([]parsedCell, len(cells))
	batchScale := 0
	batchMaxIntDig := 0
	for i, cell := range cells {
		p, err := ParseCell(cell)
		if err != nil {
			return nil, &CellError{Row: i, Cell: cell}
		}
		parsed[i] = p
		if p.null {
			continue
		}
		if p.scale > batchScale {
			batchScale = p.scale
		}
		if p.intDigits > batchMaxIntDig {
			batchMaxIntDig = p.intDigits
		}
	}

	nextScale := c.scale
	if batchScale > nextScale {
		nextScale = batchScale
	}
	nextMaxIntDig := c.maxIntDig
	if batchMaxIntDig > nextMaxIntDig {
		nextMaxIntDig = batchMaxIntDig
	}

	var nextPrecision int
	if c.hasValue || batchMaxIntDig > 0 {
		nextPrecision = nextMaxIntDig + nextScale
	}
	if nextPrecision > c.limit {
		return nil, &LimitError{Limit: c.limit, ProposedPrecision: nextPrecision}
	}

	for _, p := range parsed {
		row := storedRow{null: p.null}
		if !p.null {
			row.digits = new(big.Int).Set(p.digits)
			row.scale = p.scale
			c.hasValue = true
		}
		c.rows = append(c.rows, row)
	}
	c.scale = nextScale
	c.maxIntDig = nextMaxIntDig
	c.view = nil
	return c.View(), nil
}

// View returns the current immutable view over every accepted batch.
// Repeated calls between commits return the same instance.
func (c *Column) View() *View {
	if c.view != nil {
		return c.view
	}
	rows := make([]Row, len(c.rows))
	pow := powersOfTen(c.scale)
	for i, stored := range c.rows {
		if stored.null {
			continue
		}
		factor := new(big.Int).Quo(pow, powersOfTen(stored.scale))
		rows[i] = Row{
			Value:         new(big.Int).Mul(stored.digits, factor),
			OriginalScale: stored.scale,
		}
	}
	schema := Schema{Scale: c.scale, Defined: c.hasValue}
	if c.hasValue {
		schema.Precision = c.maxIntDig + c.scale
	}
	view := &View{schema: schema, rows: rows}
	c.view = view
	return view
}

// View is an immutable snapshot of the column at a point in time. Older
// views keep their original schema and values even after later batches
// extend the unified scale.
type View struct {
	schema Schema
	rows   []Row
}

// Schema returns the view's inferred schema.
func (v *View) Schema() Schema { return v.schema }

// Len returns the number of rows visible in the view.
func (v *View) Len() int { return len(v.rows) }

// Row returns the row at index i. The returned big.Int is a copy, so
// callers cannot mutate view state.
func (v *View) Row(i int) Row {
	row := v.rows[i]
	if row.Value != nil {
		row.Value = new(big.Int).Set(row.Value)
	}
	return row
}

// Restore reconstructs the canonical original decimal string of the row
// at index i, including its original trailing zeros. Null rows return
// NullCell.
func (v *View) Restore(i int) string {
	row := v.rows[i]
	if row.Value == nil {
		return NullCell
	}
	original := new(big.Int).Quo(row.Value, powersOfTen(v.schema.Scale-row.OriginalScale))
	return FormatDecimal(original, row.OriginalScale)
}

func trimLeadingZeros(s string) string {
	i := 0
	for i+1 < len(s) && s[i] == '0' {
		i++
	}
	return s[i:]
}

func repeatByte(b byte, n int) string {
	if n <= 0 {
		return ""
	}
	buf := make([]byte, n)
	for i := range buf {
		buf[i] = b
	}
	return string(buf)
}

func padLeft(s string, width int, b byte) string {
	if len(s) >= width {
		return s
	}
	return repeatByte(b, width-len(s)) + s
}

var powerCache = map[int]*big.Int{0: big.NewInt(1)}

func powersOfTen(n int) *big.Int {
	if n < 0 {
		panic("dataeng: negative power requested")
	}
	if p, ok := powerCache[n]; ok {
		return p
	}
	p := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(n)), nil)
	powerCache[n] = p
	return p
}
