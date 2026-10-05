package statcorr

import (
	"math/big"
	"strings"
)

// Engine holds two point series and re-derives the alignment and the
// correlation from scratch whenever either series changes.
type Engine struct {
	maxGap *big.Rat
	a, b   map[string]Point
}

// NewEngine creates an Engine with the given rational maximum gap.
func NewEngine(maxGap *big.Rat) *Engine {
	return &Engine{
		maxGap: new(big.Rat).Set(maxGap),
		a:      make(map[string]Point),
		b:      make(map[string]Point),
	}
}

// UpsertA inserts or replaces a point of series A.
func (e *Engine) UpsertA(p Point) error { return upsert(e.a, p) }

// UpsertB inserts or replaces a point of series B.
func (e *Engine) UpsertB(p Point) error { return upsert(e.b, p) }

// RemoveA deletes a point of series A by ID.
func (e *Engine) RemoveA(id string) bool { return remove(e.a, id) }

// RemoveB deletes a point of series B by ID.
func (e *Engine) RemoveB(id string) bool { return remove(e.b, id) }

// Matching recomputes the alignment of the two series.
func (e *Engine) Matching() (Matching, error) {
	return Match(pointsOf(e.a), pointsOf(e.b), e.maxGap)
}

// Evaluate recomputes the matching and, because the matching may have
// changed, rebuilds the statistics over the aligned pairs from scratch.
func (e *Engine) Evaluate() (Matching, *Stats, Correlation, error) {
	m, err := e.Matching()
	if err != nil {
		return Matching{}, nil, Correlation{}, err
	}
	st := NewStats()
	for _, p := range m.Pairs {
		st.Add(p.A.V, p.B.V)
	}
	return m, st, st.Correlation(), nil
}

// Certificate renders the matching certificate followed by the statistics
// certificate for the current state.
func (e *Engine) Certificate() (string, error) {
	m, st, _, err := e.Evaluate()
	if err != nil {
		return "", err
	}
	var sb strings.Builder
	sb.WriteString(m.Certificate())
	sb.WriteString(st.Certificate())
	return sb.String(), nil
}

func upsert(series map[string]Point, p Point) error {
	if _, ok := series[p.ID]; !ok && len(series) >= MaxPoints {
		return ErrTooManyPoints
	}
	series[p.ID] = p
	return nil
}

func remove(series map[string]Point, id string) bool {
	if _, ok := series[id]; !ok {
		return false
	}
	delete(series, id)
	return true
}

func pointsOf(series map[string]Point) []Point {
	out := make([]Point, 0, len(series))
	for _, p := range series {
		out = append(out, p)
	}
	return out
}
