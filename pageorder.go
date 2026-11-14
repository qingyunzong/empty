package dataeng

import (
	"errors"
	"fmt"
	"math"
)

// PageRole tells the solver how an image participates in page-number
// constraints. Covers and inserts are still ordered by file order and
// duplicate evidence, but they never constrain numbered body pages.
type PageRole uint8

const (
	// RoleContent is a numbered body page.
	RoleContent PageRole = iota
	// RoleCover is a cover, title page, or other unnumbered wrapper.
	RoleCover
	// RoleInsert is an inserted, foldout, or otherwise unnumbered leaf.
	RoleInsert
)

// String returns a stable name for a page role.
func (r PageRole) String() string {
	switch r {
	case RoleContent:
		return "content"
	case RoleCover:
		return "cover"
	case RoleInsert:
		return "insert"
	default:
		return fmt.Sprintf("role(%d)", uint8(r))
	}
}

// Side is the physical side of a captured image in a duplex scan.
type Side uint8

const (
	// SideUnknown means the side was not recorded. Parity evidence is skipped.
	SideUnknown Side = iota
	// SideFront is the front, recto, or first side of a physical sheet.
	SideFront
	// SideBack is the back, verso, or second side of a physical sheet.
	SideBack
)

// String returns a stable name for a scan side.
func (s Side) String() string {
	switch s {
	case SideUnknown:
		return "unknown"
	case SideFront:
		return "front"
	case SideBack:
		return "back"
	default:
		return fmt.Sprintf("side(%d)", uint8(s))
	}
}

// ParityRule controls how explicit page-number parity is compared with
// duplex scan side.
type ParityRule uint8

const (
	// FrontOddBackEven expects odd numbers on fronts and even numbers on backs.
	// This is the usual recto/verso layout and is the zero-value default.
	FrontOddBackEven ParityRule = iota
	// FrontEvenBackOdd expects even numbers on fronts and odd numbers on backs.
	FrontEvenBackOdd
	// ParityIgnored disables the duplex parity term.
	ParityIgnored
)

// NumberCandidate is one explicit page-number reading produced by OCR.
//
// Confidence is in [0, 1]. A zero Confidence means "unspecified"; it is
// treated as fully trusted. This keeps the common case
// NumberCandidate{Number: n} useful without inventing a confidence value.
type NumberCandidate struct {
	Number     int
	Confidence float64
	Source     string
}

// Page is one captured image and the evidence attached to it.
//
// FileIndex is the image's position in the source scan or file listing.
// If every page has FileIndex zero, the order of Document.Pages is used
// as the file order. Ties are resolved by the order of Document.Pages.
//
// Digest is an optional content hash (for example SHA-256) used to
// recognize duplicate scans of the same physical page. Equal non-empty
// digests corroborate shared page-number candidates. The digest does not
// remove pages from the result; every input page is placed exactly once.
//
// OCR candidates, duplex parity, and page-number constraints are only
// evaluated for RoleContent pages. Covers and inserts are transparent to
// those constraints.
//
// An empty ID is replaced with page-<input index> in results.
type Page struct {
	ID         string
	FileIndex  int
	Candidates []NumberCandidate
	Side       Side
	Digest     string
	Role       PageRole
}

// Document is a batch of captured pages plus known page-number gaps.
//
// MissingPages lists page numbers that are known to be absent. It only
// matters when Options.RequireContiguous is true: gaps composed entirely
// of declared missing pages incur no continuity cost. Missing pages are
// never required to exist in Pages.
type Document struct {
	Pages        []Page
	MissingPages []int
}

// Weights scales the individual evidence terms. Costs are always
// non-negative. A zero Weights value selects DefaultWeights; when any
// field is non-zero the struct is used as supplied, so explicitly zeroed
// terms disable that evidence.
type Weights struct {
	// OCR charges (1-confidence) for each selected page-number reading.
	OCR float64
	// PageNumber charges backward or repeated page numbers between
	// consecutive numbered body pages.
	PageNumber float64
	// Continuity charges undeclared gaps when RequireContiguous is set.
	Continuity float64
	// Parity charges a page number whose parity contradicts its scan side.
	Parity float64
	// FileOrder charges pairwise inversions of the source file order.
	FileOrder float64
	// Duplicate charges a page-number reading that is not corroborated by
	// other pages carrying the same digest.
	Duplicate float64
	// Unnumbered charges deliberately discarding available OCR evidence.
	Unnumbered float64
}

// DefaultWeights returns the weights used when Options.Weights is the zero
// value.
func DefaultWeights() Weights {
	return Weights{
		OCR:        1,
		PageNumber: 4,
		Continuity: 1.5,
		Parity:     2,
		FileOrder:  0.75,
		Duplicate:  2,
		Unnumbered: 3,
	}
}

// Options configures a Solver.
//
// The zero value is usable and selects the defaults documented on each
// field. Set CostWindow to a very small positive number (for example
// 1e-9) when only exactly tied arrangements should be reported.
type Options struct {
	Weights Weights

	// Parity selects the duplex parity convention. The zero value is
	// FrontOddBackEven.
	Parity ParityRule

	// RequireContiguous requires consecutive numbered body pages to differ
	// by one, except for gaps made entirely of declared MissingPages. It
	// is false by default, so arbitrary missing runs are tolerated.
	RequireContiguous bool

	// MaxCandidates caps the number of arrangements returned. Zero selects
	// 5. Equal or near-equal arrangements are reported together instead of
	// silently choosing one.
	MaxCandidates int

	// CostWindow includes every arrangement whose cost is at most
	// best+CostWindow. Zero selects 0.5. Negative values are rejected.
	CostWindow float64

	// ExactMaxPages is the largest batch Solve will solve by exhaustive
	// dynamic programming. Zero selects 12. SolveExact uses the hard
	// implementation limit and the size check instead of this threshold.
	ExactMaxPages int

	// BeamWidth is the number of partial arrangements retained by the
	// heuristic solver for large batches. Zero selects 96.
	BeamWidth int
}

// Placement is one page in a candidate arrangement.
type Placement struct {
	PageID string
	// InputIndex is the index in Document.Pages.
	InputIndex int
	FileIndex  int
	Role       PageRole
	Side       Side
	Digest     string

	// Number is the selected explicit page number. It is meaningful only
	// when HasNumber is true.
	Number    int
	HasNumber bool
	// Confidence is the effective OCR confidence of the selected reading.
	Confidence float64
	Source     string

	// DuplicateOf is the ID of the first page already placed with the same
	// non-empty digest. It is empty for the first occurrence.
	DuplicateOf string
}

// CostBreakdown decomposes the total arrangement cost by evidence type.
type CostBreakdown struct {
	OCR        float64
	Unnumbered float64
	PageNumber float64
	Continuity float64
	Parity     float64
	FileOrder  float64
	Duplicate  float64
	Total      float64
}

// Arrangement is one plausible ordering of the batch.
type Arrangement struct {
	Pages     []Placement
	Cost      float64
	Breakdown CostBreakdown
}

// Order returns the page IDs in arrangement order.
func (a Arrangement) Order() []string {
	ids := make([]string, len(a.Pages))
	for i := range a.Pages {
		ids[i] = a.Pages[i].PageID
	}
	return ids
}

// Result contains ranked arrangements and the solver's guarantees.
type Result struct {
	// Candidates is sorted by increasing cost. When equally or nearly
	// equally credible interpretations exist, all of them are retained
	// within the configured CostWindow.
	Candidates []Arrangement
	// Exhaustive is true when the result was produced by the exact solver.
	// The first candidate is then a provable global optimum.
	Exhaustive bool
	// Conflict is true when more than one arrangement was retained.
	Conflict bool
	// Truncated is true when at least one additional arrangement fell
	// inside the cost window but was cut by MaxCandidates or by the exact
	// solver's internal k-best width.
	Truncated bool
}

// ErrTooManyPages is returned by SolveExact when a batch is too large for
// the exact state space.
var ErrTooManyPages = errors.New("dataeng: batch too large for exact solution")

var (
	errBadWeights = errors.New("dataeng: weights must be finite and non-negative")
)

func normalizeOptions(opts Options) (Options, error) {
	if opts.Weights == (Weights{}) {
		opts.Weights = DefaultWeights()
	}
	w := &opts.Weights
	for _, v := range []float64{
		w.OCR, w.PageNumber, w.Continuity, w.Parity,
		w.FileOrder, w.Duplicate, w.Unnumbered,
	} {
		if math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			return Options{}, fmt.Errorf("%w: %v", errBadWeights, v)
		}
	}

	if opts.MaxCandidates == 0 {
		opts.MaxCandidates = 5
	}
	if opts.MaxCandidates < 0 {
		return Options{}, fmt.Errorf("dataeng: MaxCandidates must be positive")
	}
	if opts.CostWindow == 0 {
		opts.CostWindow = 0.5
	}
	if opts.CostWindow < 0 || math.IsNaN(opts.CostWindow) || math.IsInf(opts.CostWindow, 0) {
		return Options{}, fmt.Errorf("dataeng: CostWindow must be finite and non-negative")
	}
	if opts.ExactMaxPages == 0 {
		opts.ExactMaxPages = 12
	}
	if opts.ExactMaxPages < 0 || opts.ExactMaxPages > maxExactPages {
		return Options{}, fmt.Errorf("dataeng: ExactMaxPages must be between 0 and %d", maxExactPages)
	}
	if opts.BeamWidth == 0 {
		opts.BeamWidth = 96
	}
	if opts.BeamWidth < 0 {
		return Options{}, fmt.Errorf("dataeng: BeamWidth must be positive")
	}
	if opts.Parity > ParityIgnored {
		return Options{}, fmt.Errorf("dataeng: unknown parity rule %d", uint8(opts.Parity))
	}
	return opts, nil
}
