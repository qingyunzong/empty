package virtualarray

import "math/big"

// preparedMapping is a validated mapping with precomputed selections and
// source strides.
type preparedMapping struct {
	index       int
	sourceName  string
	sourceShape []*big.Int
	order       Order
	virtual     *preparedSel
	source      *preparedSel

	// sourceStrides[d] is the linear-index increment of one step along
	// source axis d under the source storage order.
	sourceStrides []*big.Int
}

// VirtualArray is an immutable, validated virtual dataset ready for reads.
type VirtualArray struct {
	shape []*big.Int
	fill  int64

	mappings []*preparedMapping

	// sourceStrides and sourceOrder are shared by every mapping referencing
	// the same source name; New guarantees identical shape and order.
	sourceStrides map[string][]*big.Int
	sourceOrder   map[string]Order
}

// New validates the complete mapping metadata and builds a virtual array.
//
// virtualShape is the virtual dataset shape (rank 1..8, non-negative
// lengths). fill is the fixed int64 fill value and is never confused with a
// missing source value. mappings are kept in supplied order; when a virtual
// point is selected by several mappings the last one wins. sourceOrder gives
// the storage order of every referenced source and must contain every
// mapping's SourceName. Same-named sources must declare an identical shape
// and order across all mappings.
func New(virtualShape []*big.Int, fill int64, mappings []Mapping, sourceOrder map[string]Order) (*VirtualArray, error) {
	shape, err := validateShape(virtualShape)
	if err != nil {
		return nil, err
	}
	if sourceOrder == nil {
		sourceOrder = map[string]Order{}
	}

	va := &VirtualArray{
		shape:         shape,
		fill:          fill,
		sourceStrides: map[string][]*big.Int{},
		sourceOrder:   map[string]Order{},
	}

	knownShape := map[string][]*big.Int{}

	for idx, m := range mappings {
		if m.SourceName == "" {
			return nil, ErrInvalidMapping
		}
		order := m.Order
		if !order.valid() {
			var ok bool
			order, ok = sourceOrder[m.SourceName]
			if !ok || !order.valid() {
				return nil, ErrInvalidMapping
			}
		} else if table, ok := sourceOrder[m.SourceName]; ok && table != order {
			return nil, ErrInvalidMapping
		}

		srcShape, err := validateShape(m.SourceShape)
		if err != nil {
			return nil, err
		}

		vsel, err := prepareSelection(m.VirtualSel, shape)
		if err != nil {
			return nil, err
		}
		ssel, err := prepareSelection(m.SourceSel, srcShape)
		if err != nil {
			return nil, err
		}

		// Point counts must match exactly, including both being empty.
		if vsel.total.Cmp(ssel.total) != 0 {
			return nil, ErrInvalidMapping
		}

		if prior, exists := knownShape[m.SourceName]; exists {
			if !shapeEqual(prior, srcShape) {
				return nil, ErrInvalidMapping
			}
			if va.sourceOrder[m.SourceName] != order {
				return nil, ErrInvalidMapping
			}
		} else {
			knownShape[m.SourceName] = srcShape
			va.sourceOrder[m.SourceName] = order
			va.sourceStrides[m.SourceName] = computeStrides(srcShape, order)
		}

		va.mappings = append(va.mappings, &preparedMapping{
			index:         idx,
			sourceName:    m.SourceName,
			sourceShape:   srcShape,
			order:         order,
			virtual:       vsel,
			source:        ssel,
			sourceStrides: va.sourceStrides[m.SourceName],
		})
	}

	return va, nil
}

// Shape returns a defensive copy of the virtual array shape.
func (va *VirtualArray) Shape() []*big.Int {
	out := make([]*big.Int, len(va.shape))
	for d, dim := range va.shape {
		out[d] = cloneBig(dim)
	}
	return out
}

// Fill returns the configured fill value.
func (va *VirtualArray) Fill() int64 {
	return va.fill
}

func shapeEqual(a, b []*big.Int) bool {
	if len(a) != len(b) {
		return false
	}
	for d := range a {
		if a[d].Cmp(b[d]) != 0 {
			return false
		}
	}
	return true
}

// computeStrides returns per-axis linear-index multipliers for a shape in
// the requested storage order. C order varies the last axis fastest;
// Fortran order varies the first axis fastest.
func computeStrides(shape []*big.Int, order Order) []*big.Int {
	rank := len(shape)
	strides := make([]*big.Int, rank)
	switch order {
	case FOrder:
		stride := big.NewInt(1)
		for d := 0; d < rank; d++ {
			strides[d] = new(big.Int).Set(stride)
			stride = new(big.Int).Mul(stride, shape[d])
		}
	default: // COrder
		stride := big.NewInt(1)
		for d := rank - 1; d >= 0; d-- {
			strides[d] = new(big.Int).Set(stride)
			stride = new(big.Int).Mul(stride, shape[d])
		}
	}
	return strides
}

// linearIndex flattens a source coordinate under precomputed strides.
func linearIndex(coord, strides []*big.Int) *big.Int {
	idx := big.NewInt(0)
	for d, c := range coord {
		idx.Add(idx, new(big.Int).Mul(c, strides[d]))
	}
	return idx
}

func cloneCoords(coord []*big.Int) []*big.Int {
	out := make([]*big.Int, len(coord))
	for d, c := range coord {
		out[d] = cloneBig(c)
	}
	return out
}
