package dataeng

import (
	"fmt"
	"sort"
)

// RowRange is a half-open interval of absolute file row indexes [Start, End).
type RowRange struct {
	Start int64
	End   int64
}

// Interval is an alias for RowRange.
type Interval = RowRange

func (r RowRange) length() int64 {
	if r.End <= r.Start {
		return 0
	}
	return r.End - r.Start
}

// RowGroupResult records the pruning decision for one stripe row group.
type RowGroupResult struct {
	Stripe   int
	Group    int
	StartRow int64
	EndRow   int64
	Selected bool
	Reason   string
}

// PruneResult contains the candidate row intervals and per-group decisions.
type PruneResult struct {
	Ranges []RowRange
	// GroupRanges contains the same selected row groups without merging
	// adjacent intervals. Ranges is the compacted form.
	GroupRanges     []RowRange
	Groups          []RowGroupResult
	TotalRows       int64
	CandidateRows   int64
	TotalGroups     int
	CandidateGroups int
}

// RowGroup exposes the loaded index information for one row group.
type RowGroup struct {
	Stripe       int
	Group        int
	StartRow     int64
	EndRow       int64
	Statistics   map[uint32]*ColumnStatistics
	BloomFilters map[uint32]*BloomFilter
	Positions    map[uint32][]uint64
}

// Prune returns all row intervals whose statistics or bloom filters cannot
// prove that the predicate is false. It is conservative: missing or untrusted
// statistics produce a may-match selection.
func (r *Reader) Prune(p Predicate) (PruneResult, error) {
	for _, name := range p.Columns() {
		if _, err := r.findColumn(name); err != nil {
			return PruneResult{}, err
		}
	}

	stride := r.RowIndexStride()
	result := PruneResult{TotalRows: r.NumberOfRows()}
	for si := range r.stripes {
		stripe := &r.stripes[si]
		rows := stripe.NumberOfRows
		if rows == 0 {
			continue
		}
		groups := groupCount(rows, stride)
		if groups <= 0 {
			groups = 1
		}
		for g := 0; g < groups; g++ {
			startInStripe := uint64(0)
			if stride > 0 {
				startInStripe = uint64(g * stride)
			}
			endInStripe := rows
			if stride > 0 {
				next := uint64((g + 1) * stride)
				if next < rows {
					endInStripe = next
				}
			}
			if startInStripe >= endInStripe {
				continue
			}
			groupRows := endInStripe - startInStripe
			truth := r.evalPredicateGroup(p, si, g, groupRows)
			selected := truth.CouldMatch()

			absStart := stripe.FirstRow + int64(startInStripe)
			absEnd := stripe.FirstRow + int64(endInStripe)
			reason := "may-match"
			if !selected {
				reason = "pruned"
			}
			result.TotalGroups++
			result.Groups = append(result.Groups, RowGroupResult{
				Stripe:   si,
				Group:    g,
				StartRow: absStart,
				EndRow:   absEnd,
				Selected: selected,
				Reason:   reason,
			})
			if selected {
				result.CandidateGroups++
				rr := RowRange{Start: absStart, End: absEnd}
				result.GroupRanges = append(result.GroupRanges, rr)
				result.Ranges = append(result.Ranges, rr)
			}
		}
	}
	result.Ranges = coalesceRanges(result.Ranges)
	// CandidateRows is the size of the candidate intervals, which can be
	// smaller after adjacent groups are coalesced only if the input had holes.
	// Recompute from the final ranges to keep the API unambiguous.
	result.CandidateRows = 0
	for _, rr := range result.Ranges {
		result.CandidateRows += rr.length()
	}
	return result, nil
}

// PruneRanges is a convenience wrapper returning only the intervals.
func (r *Reader) PruneRanges(p Predicate) ([]RowRange, error) {
	res, err := r.Prune(p)
	if err != nil {
		return nil, err
	}
	return res.Ranges, nil
}

// CandidateRanges is an alias for PruneRanges.
func (r *Reader) CandidateRanges(p Predicate) ([]RowRange, error) {
	return r.PruneRanges(p)
}

// PruneIntervals is an alias for PruneRanges.
func (r *Reader) PruneIntervals(p Predicate) ([]RowRange, error) {
	return r.PruneRanges(p)
}

func (r *Reader) evalPredicateGroup(p Predicate, stripe, group int, rows uint64) Truth {
	switch p.op {
	case opAnd:
		t := TruthYes
		for _, c := range p.children {
			t = andTruth(t, r.evalPredicateGroup(c, stripe, group, rows))
		}
		return t
	case opOr:
		t := TruthNo
		for _, c := range p.children {
			t = orTruth(t, r.evalPredicateGroup(c, stripe, group, rows))
		}
		return t
	case opNot:
		if len(p.children) == 1 {
			return notTruth(r.evalPredicateGroup(p.children[0], stripe, group, rows))
		}
		return TruthMaybe
	}

	col, err := r.findColumn(p.column)
	if err != nil {
		return TruthMaybe
	}
	var rowStats *ColumnStatistics
	var bloom *BloomFilter
	if r.RowIndexStride() > 0 {
		if ri := r.rowIndexFor(stripe, col.ID); ri != nil && group >= 0 && group < len(ri.Entries) {
			rowStats = ri.Entries[group].Statistics
		}
		if bfs := r.bloomsFor(stripe, col.ID); group >= 0 && group < len(bfs) {
			bloom = bfs[group]
		}
	}
	var nullStats *ColumnStatistics
	if rowStats != nil {
		// Row-index statistics are exact for the group, including null counts.
		nullStats = rowStats
	} else if stripe >= 0 && stripe < len(r.stripes) && rows == r.stripes[stripe].NumberOfRows {
		// Without a row index, stripe-level statistics are exact only when the
		// group covers the whole stripe. A footer aggregate is never exact for
		// an individual group, so it is used for bounds only.
		ss := r.stripes[stripe].Statistics
		if int(col.ID) < len(ss) {
			nullStats = ss[col.ID]
		}
	} else {
		// An aggregate cannot tell us which group contains nulls, but it can
		// safely prove that the whole file/stripe has none or is entirely NULL.
		nullStats = aggregateNullStats(r.stripeStats(stripe, col.ID))
	}
	return r.evalLeaf(evalGroup{
		reader:             r,
		stripe:             stripe,
		column:             col,
		rowStats:           rowStats,
		stripeStats:        r.stripeStats(stripe, col.ID),
		nullStats:          nullStats,
		aggregateNullStats: aggregateNullStats(r.stripeStats(stripe, col.ID)),
		bloom:              bloom,
		bloomEncoding:      r.bloomEncoding(stripe, col.ID),
		rows:               rows,
	}, p.op, p.values)
}

func aggregateNullStats(s *ColumnStatistics) *ColumnStatistics {
	if s == nil {
		return nil
	}
	if s.HasNumberOfValues && s.NumberOfValues == 0 {
		return &ColumnStatistics{HasNumberOfValues: true}
	}
	if s.HasNullSet && !s.HasNull {
		return &ColumnStatistics{HasNullSet: true}
	}
	return nil
}

func coalesceRanges(in []RowRange) []RowRange {
	if len(in) == 0 {
		return nil
	}
	sort.Slice(in, func(i, j int) bool {
		if in[i].Start == in[j].Start {
			return in[i].End < in[j].End
		}
		return in[i].Start < in[j].Start
	})
	out := make([]RowRange, 0, len(in))
	for _, r := range in {
		if r.End <= r.Start {
			continue
		}
		if len(out) == 0 || r.Start > out[len(out)-1].End {
			out = append(out, r)
			continue
		}
		if r.End > out[len(out)-1].End {
			out[len(out)-1].End = r.End
		}
	}
	return out
}

// RowGroups loads and returns row-group statistics and bloom filters. It is
// primarily a diagnostics/inspection API; Prune itself loads data lazily.
func (r *Reader) RowGroups() ([]RowGroup, error) {
	stride := r.RowIndexStride()
	var out []RowGroup
	for si := range r.stripes {
		stripe := &r.stripes[si]
		if stripe.NumberOfRows == 0 {
			continue
		}
		groups := groupCount(stripe.NumberOfRows, stride)
		if groups <= 0 {
			groups = 1
		}
		for g := 0; g < groups; g++ {
			start := uint64(0)
			if stride > 0 {
				start = uint64(g * stride)
			}
			end := stripe.NumberOfRows
			if stride > 0 {
				next := uint64((g + 1) * stride)
				if next < end {
					end = next
				}
			}
			if start >= end {
				continue
			}
			rg := RowGroup{
				Stripe:       si,
				Group:        g,
				StartRow:     stripe.FirstRow + int64(start),
				EndRow:       stripe.FirstRow + int64(end),
				Statistics:   map[uint32]*ColumnStatistics{},
				BloomFilters: map[uint32]*BloomFilter{},
				Positions:    map[uint32][]uint64{},
			}
			for _, col := range r.schema {
				if ri := r.rowIndexFor(si, col.ID); ri != nil && g < len(ri.Entries) {
					rg.Statistics[col.ID] = ri.Entries[g].Statistics
					rg.Positions[col.ID] = append([]uint64(nil), ri.Entries[g].Positions...)
				}
				if bfs := r.bloomsFor(si, col.ID); g < len(bfs) {
					rg.BloomFilters[col.ID] = bfs[g]
				}
			}
			out = append(out, rg)
		}
	}
	return out, nil
}

// ContainsRow reports whether row is inside any candidate interval.
func ContainsRow(ranges []RowRange, row int64) bool {
	for _, r := range ranges {
		if row >= r.Start && row < r.End {
			return true
		}
	}
	return false
}

// VerifyNoFalseNegatives compares pruning against a row-level source. rowAt
// must return the evaluated values for every row in [0, NumberOfRows). Any row
// that satisfies the predicate but is outside the candidate ranges is a
// correctness error.
func (r *Reader) VerifyNoFalseNegatives(p Predicate, rowAt func(row int64) (map[string]Value, error)) error {
	res, err := r.Prune(p)
	if err != nil {
		return err
	}
	for row := int64(0); row < r.NumberOfRows(); row++ {
		values, err := rowAt(row)
		if err != nil {
			return fmt.Errorf("dataeng: read row %d: %w", row, err)
		}
		if p.Evaluate(values) && !ContainsRow(res.Ranges, row) {
			return fmt.Errorf("dataeng: false negative at row %d for predicate %s", row, p.String())
		}
	}
	return nil
}

// CheckNoFalseNegatives is a storage-agnostic zero-false-negative check.
// match must report the exact row-level predicate result for every row.
func CheckNoFalseNegatives(ranges []RowRange, totalRows int64, match func(row int64) (bool, error)) error {
	for row := int64(0); row < totalRows; row++ {
		ok, err := match(row)
		if err != nil {
			return fmt.Errorf("dataeng: read row %d: %w", row, err)
		}
		if ok && !ContainsRow(ranges, row) {
			return fmt.Errorf("dataeng: false negative at row %d", row)
		}
	}
	return nil
}
