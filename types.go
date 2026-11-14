package dataeng

// Rect is an axis-aligned rectangle in page coordinates. Coordinates may use
// either a top-left or a bottom-left origin; orientation is inferred from the
// header and footer regions, or from Options.TopOrigin.
type Rect struct {
	X0 float64 `json:"x0"`
	Y0 float64 `json:"y0"`
	X1 float64 `json:"x1"`
	Y1 float64 `json:"y1"`
}

// Bounds and CellRect are convenience aliases for Rect.
type (
	Bounds   = Rect
	CellRect = Rect
)

// NewRect returns a rectangle with normalized corners.
func NewRect(x0, y0, x1, y1 float64) Rect {
	return Rect{X0: x0, Y0: y0, X1: x1, Y1: y1}.normalized()
}

func (r Rect) normalized() Rect {
	if r.X0 > r.X1 {
		r.X0, r.X1 = r.X1, r.X0
	}
	if r.Y0 > r.Y1 {
		r.Y0, r.Y1 = r.Y1, r.Y0
	}
	return r
}

// IsEmpty reports whether the rectangle has no positive area. A zero Rect is
// used to mean "no header/footer region supplied".
func (r Rect) IsEmpty() bool {
	r = r.normalized()
	return r.X1-r.X0 <= geometryEpsilon || r.Y1-r.Y0 <= geometryEpsilon
}

// Width returns the rectangle width.
func (r Rect) Width() float64 {
	r = r.normalized()
	return r.X1 - r.X0
}

// Height returns the rectangle height.
func (r Rect) Height() float64 {
	r = r.normalized()
	return r.Y1 - r.Y0
}

// CenterX returns the horizontal center of the rectangle.
func (r Rect) CenterX() float64 {
	r = r.normalized()
	return (r.X0 + r.X1) / 2
}

// CenterY returns the vertical center of the rectangle.
func (r Rect) CenterY() float64 {
	r = r.normalized()
	return (r.Y0 + r.Y1) / 2
}

// ContainsPoint reports whether x, y lies inside the rectangle.
func (r Rect) ContainsPoint(x, y float64) bool {
	r = r.normalized()
	return x >= r.X0 && x <= r.X1 && y >= r.Y0 && y <= r.Y1
}

// Cell is one recognized table cell.
//
// Bounds is the cell box as recognized on the page. RowSpan and ColSpan
// describe merged cells; values less than one are treated as one. Merged cells
// are never split or reconstructed from their text.
//
// Header marks a cell that the document recognizer classified as part of a
// table header. Header cells are resolved by geometry and table-header
// signatures; the flag is optional.
type Cell struct {
	ID     string `json:"id,omitempty"`
	Text   string `json:"text,omitempty"`
	Bounds Rect   `json:"bounds"`

	RowSpan int  `json:"row_span,omitempty"`
	ColSpan int  `json:"col_span,omitempty"`
	Header  bool `json:"header,omitempty"`

	// Column and Row are filled by Assemble. They are zero-based and are
	// ignored when Cell is supplied as input.
	Column int `json:"column,omitempty"`
	Row    int `json:"row,omitempty"`

	Source CellSource `json:"source,omitempty"`
}

// CellSource records where an output cell came from.
type CellSource struct {
	Page     int  `json:"page"`
	Fragment int  `json:"fragment"`
	Header   bool `json:"header,omitempty"`
}

// Border is a recognized page line. Axis-aligned horizontal and vertical
// lines are used; diagonal lines are ignored.
type Border struct {
	X0        float64 `json:"x0"`
	Y0        float64 `json:"y0"`
	X1        float64 `json:"x1"`
	Y1        float64 `json:"y1"`
	Thickness float64 `json:"thickness,omitempty"`
}

// Line and BorderLine are convenience aliases for Border.
type (
	Line       = Border
	BorderLine = Border
)

// Page is one recognized PDF page. Cells that lie in HeaderRegion or
// FooterRegion are treated as running page furniture and are excluded from
// table fragments.
//
// Width and Height are optional. They are used for geometry normalization and
// page-break tests; if they are zero they are inferred from the supplied
// objects.
type Page struct {
	Number       int      `json:"number"`
	Width        float64  `json:"width,omitempty"`
	Height       float64  `json:"height,omitempty"`
	Cells        []Cell   `json:"cells"`
	Borders      []Border `json:"borders,omitempty"`
	HeaderRegion Rect     `json:"header_region,omitempty"`
	FooterRegion Rect     `json:"footer_region,omitempty"`
}

// Column describes a column in an assembled table. Left and Right are
// fractions of the canonical table width, which keeps the column frame
// comparable when pages have different physical sizes.
type Column struct {
	Index int     `json:"index"`
	Left  float64 `json:"left"`
	Right float64 `json:"right"`
	Width float64 `json:"width"`
}

// Row is a logical, but not necessarily physically contiguous, table row.
// A row that is clipped at a page edge is kept as its own row fragment; it is
// never joined to another row by text similarity. Partial is true when the row
// appears to be cut by a page or when cells for some columns are absent at a
// clipped edge.
type Row struct {
	Index   int       `json:"index"`
	Cells   []Cell    `json:"cells"`
	Source  RowSource `json:"source"`
	Partial bool      `json:"partial,omitempty"`
}

// RowSource records the page and table fragment that produced a row.
type RowSource struct {
	Page     int `json:"page"`
	Fragment int `json:"fragment"`
}

// HeaderOccurrence is one occurrence of the table header. Every occurrence
// keeps the original rows, cells and source page. Removed is true for a
// repeated header that was dropped from the assembled body.
type HeaderOccurrence struct {
	Source    RowSource `json:"source"`
	Rows      []Row     `json:"rows"`
	Canonical bool      `json:"canonical,omitempty"`
	Removed   bool      `json:"removed,omitempty"`
	Inferred  bool      `json:"inferred,omitempty"`
	Signature string    `json:"signature,omitempty"`
}

// PageRef records a table fragment that contributed to a table.
type PageRef struct {
	Page          int  `json:"page"`
	Fragment      int  `json:"fragment"`
	HeaderRemoved bool `json:"header_removed,omitempty"`
	FirstDataRow  int  `json:"first_data_row"`
	LastDataRow   int  `json:"last_data_row"`
}

// PageBoundary records the evidence used at a page transition.
type PageBoundary struct {
	FromPage      int     `json:"from_page"`
	ToPage        int     `json:"to_page"`
	FromFragment  int     `json:"from_fragment"`
	ToFragment    int     `json:"to_fragment"`
	ColumnScore   float64 `json:"column_score"`
	HeaderScore   float64 `json:"header_score"`
	BreakScore    float64 `json:"break_score"`
	Confidence    float64 `json:"confidence"`
	HeaderRemoved bool    `json:"header_removed,omitempty"`
	// RowSplit is true when the last row on FromPage and the first row on
	// ToPage both look clipped. The two fragments remain separate rows; no
	// text-based reconstruction is attempted.
	RowSplit bool `json:"row_split,omitempty"`
}

// WarningCode identifies a non-fatal assembly issue.
type WarningCode string

const (
	WarnAmbiguousBreak WarningCode = "ambiguous_page_break"
	WarnInferredHeader WarningCode = "inferred_header"
	WarnCrossPageRow   WarningCode = "cross_page_row"
	WarnInvalidPage    WarningCode = "invalid_page"
)

// Warning describes a decision that could not be made with full confidence.
// When a page transition is ambiguous the fragments are kept as separate
// tables.
type Warning struct {
	Code    WarningCode `json:"code"`
	Page    int         `json:"page,omitempty"`
	Message string      `json:"message"`
}

// Table is one assembled table, possibly spanning several pages.
type Table struct {
	ID                string             `json:"id"`
	Columns           []Column           `json:"columns"`
	Header            []Row              `json:"header,omitempty"`
	HeaderOccurrences []HeaderOccurrence `json:"header_occurrences,omitempty"`
	Rows              []Row              `json:"rows"`
	Pages             []PageRef          `json:"pages"`
	Boundaries        []PageBoundary     `json:"boundaries,omitempty"`
	Confidence        float64            `json:"confidence"`
	Warnings          []Warning          `json:"warnings,omitempty"`
}

// Options controls continuation heuristics. The zero Options is not used
// directly; use DefaultOptions and functional options with Assemble.
type Options struct {
	// TopOrigin forces a coordinate convention. Nil means infer it from the
	// header/footer regions.
	TopOrigin *bool

	// HeaderSimilarity is the minimum normalized similarity for two header
	// signatures to be considered the same. Default 0.82.
	HeaderSimilarity float64

	// MinConfidence is the minimum evidence score needed to join fragments
	// across pages. Default 0.75. Ambiguous transitions fall back to separate
	// tables.
	MinConfidence float64

	// ColumnTolerance is the maximum normalized column-boundary displacement
	// accepted as the same column geometry. Default 0.08.
	ColumnTolerance float64

	// BreakTolerance is the fraction of page height within which a fragment
	// edge is considered clipped at the page body boundary. Default 0.06.
	BreakTolerance float64

	// AssumeFirstRowHeader treats the first row of a fragment as a header
	// candidate when the recognizer did not mark header cells. Default true.
	AssumeFirstRowHeader bool

	// FragmentGapRows is the vertical gap, measured in median row heights,
	// above which page cells are split into separate table fragments. Default
	// 2.5.
	FragmentGapRows float64
}

// DefaultOptions returns the heuristic defaults.
func DefaultOptions() Options {
	return Options{
		HeaderSimilarity:     0.82,
		MinConfidence:        0.75,
		ColumnTolerance:      0.08,
		BreakTolerance:       0.06,
		AssumeFirstRowHeader: true,
		FragmentGapRows:      2.5,
	}
}

// Option mutates Options.
type Option func(*Options)

// WithTopOrigin forces the y-axis convention. topOrigin=true means y grows
// downward (the usual image/OCR convention); false means y grows upward (the
// PDF convention).
func WithTopOrigin(topOrigin bool) Option {
	return func(o *Options) {
		o.TopOrigin = &topOrigin
	}
}

// WithHeaderSimilarity sets the header signature threshold.
func WithHeaderSimilarity(v float64) Option {
	return func(o *Options) {
		if v > 0 {
			o.HeaderSimilarity = v
		}
	}
}

// WithMinConfidence sets the page-continuation confidence threshold.
func WithMinConfidence(v float64) Option {
	return func(o *Options) {
		if v > 0 && v <= 1 {
			o.MinConfidence = v
		}
	}
}

// WithColumnTolerance sets the normalized column-geometry tolerance.
func WithColumnTolerance(v float64) Option {
	return func(o *Options) {
		if v > 0 {
			o.ColumnTolerance = v
		}
	}
}

// WithBreakTolerance sets the page-edge tolerance as a fraction of page height.
func WithBreakTolerance(v float64) Option {
	return func(o *Options) {
		if v > 0 {
			o.BreakTolerance = v
		}
	}
}

// WithAssumeFirstRowHeader controls header candidate inference.
func WithAssumeFirstRowHeader(v bool) Option {
	return func(o *Options) {
		o.AssumeFirstRowHeader = v
	}
}

// WithFragmentGapRows sets the gap used to split page cells into fragments.
func WithFragmentGapRows(v float64) Option {
	return func(o *Options) {
		if v > 0 {
			o.FragmentGapRows = v
		}
	}
}

func applyOptions(opts []Option) Options {
	o := DefaultOptions()
	for _, opt := range opts {
		if opt != nil {
			opt(&o)
		}
	}
	return o
}

const geometryEpsilon = 1e-9

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func absFloat(a float64) float64 {
	if a < 0 {
		return -a
	}
	return a
}

func mean(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	var sum float64
	for _, x := range v {
		sum += x
	}
	return sum / float64(len(v))
}

func median(v []float64) float64 {
	if len(v) == 0 {
		return 0
	}
	sortFloat64s(v)
	n := len(v)
	if n%2 == 1 {
		return v[n/2]
	}
	return (v[n/2-1] + v[n/2]) / 2
}

func sortFloat64s(v []float64) {
	for i := 1; i < len(v); i++ {
		x := v[i]
		j := i
		for j > 0 && v[j-1] > x {
			v[j] = v[j-1]
			j--
		}
		v[j] = x
	}
}
