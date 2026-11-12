package virtualarray

import (
	"math/big"
)

// axisSel holds the validated parameters of one [AxisSel] together with the
// precomputed suffix product used to rank and unrank points.
type axisSel struct {
	start  *big.Int
	stride *big.Int
	count  *big.Int
	block  *big.Int

	// suffix is the product of counts*blocks of all axes after this one.
	// For the last axis suffix is 1.
	suffix *big.Int
}

// preparedSel is a fully validated selection with no retained pointers into
// caller-supplied big.Int values.
type preparedSel struct {
	rank int
	axes []axisSel
	// total is the exact number of selected points (product of count*block).
	total *big.Int
	// empty mirrors total.Sign() == 0.
	empty bool
}

func cloneBig(x *big.Int) *big.Int {
	if x == nil {
		return nil
	}
	return new(big.Int).Set(x)
}

// validateShape checks rank and non-negative lengths and returns defensive
// copies.
func validateShape(shape []*big.Int) ([]*big.Int, error) {
	if len(shape) < minRank || len(shape) > maxRank {
		return nil, ErrInvalidShape
	}
	out := make([]*big.Int, len(shape))
	for d, dim := range shape {
		if dim == nil || dim.Sign() < 0 {
			return nil, ErrInvalidShape
		}
		out[d] = cloneBig(dim)
	}
	return out, nil
}

// prepareSelection validates sel against shape and precomputes per-axis
// metadata. Even an empty (zero-count) selection is fully checked: rank,
// positive stride/block and start <= dimension length are always required,
// but a fabricated last selected coordinate is not required to fit.
func prepareSelection(sel Selection, shape []*big.Int) (*preparedSel, error) {
	if len(shape) < minRank || len(shape) > maxRank {
		return nil, ErrInvalidShape
	}
	if len(sel.Axes) != len(shape) {
		return nil, ErrInvalidSelection
	}

	ps := &preparedSel{rank: len(shape), total: big.NewInt(1)}
	ps.axes = make([]axisSel, len(sel.Axes))
	anyEmpty := false

	for d, ax := range sel.Axes {
		if ax.Start == nil || ax.Stride == nil || ax.Count == nil || ax.Block == nil {
			return nil, ErrInvalidSelection
		}
		if ax.Start.Sign() < 0 || ax.Count.Sign() < 0 {
			return nil, ErrInvalidSelection
		}
		if ax.Stride.Sign() <= 0 || ax.Block.Sign() <= 0 {
			return nil, ErrInvalidSelection
		}
		if ax.Stride.Cmp(ax.Block) < 0 {
			return nil, ErrInvalidSelection
		}
		// start is always required to fit the dimension, including empties.
		if ax.Start.Cmp(shape[d]) > 0 {
			return nil, ErrInvalidSelection
		}

		axisEmpty := ax.Count.Sign() == 0
		if !axisEmpty {
			// Last selected coordinate on this axis:
			// start + (count-1)*stride + (block-1) must be < shape[d].
			last := new(big.Int).Sub(ax.Count, big.NewInt(1))
			last.Mul(last, ax.Stride)
			last.Add(last, ax.Block)
			last.Sub(last, big.NewInt(1))
			last.Add(last, ax.Start)
			if last.Cmp(shape[d]) >= 0 {
				return nil, ErrInvalidSelection
			}
		}

		ps.axes[d] = axisSel{
			start:  cloneBig(ax.Start),
			stride: cloneBig(ax.Stride),
			count:  cloneBig(ax.Count),
			block:  cloneBig(ax.Block),
		}
		if axisEmpty {
			anyEmpty = true
		}
	}

	if anyEmpty {
		ps.empty = true
		ps.total = big.NewInt(0)
	}

	// Suffix products and total. Walk axes last-to-first; suffix of axis d is
	// the number of points spanned by axes d+1..rank-1.
	prod := big.NewInt(1)
	for d := len(ps.axes) - 1; d >= 0; d-- {
		ps.axes[d].suffix = new(big.Int).Set(prod)
		if !ps.empty {
			axisCount := new(big.Int).Mul(ps.axes[d].count, ps.axes[d].block)
			prod = new(big.Int).Mul(prod, axisCount)
		}
	}
	if !ps.empty {
		ps.total = prod
	}
	return ps, nil
}

// contains reports whether coordinate coord is selected. Every axis is
// tested independently: the offset from start must resolve to a block index
// i in [0,count) and an in-block offset j in [0,block).
func (ps *preparedSel) contains(coord []*big.Int) bool {
	if ps.empty || len(coord) != ps.rank {
		return false
	}
	for d, ax := range ps.axes {
		x := coord[d]
		if x == nil || x.Cmp(ax.start) < 0 {
			return false
		}
		off := new(big.Int).Sub(x, ax.start)
		// i = off / stride; valid only when i < count and the remainder
		// j = off - i*stride is within block.
		i := new(big.Int).Quo(off, ax.stride)
		if i.Cmp(ax.count) >= 0 {
			return false
		}
		j := new(big.Int).Mul(i, ax.stride)
		j.Sub(off, j)
		if j.Cmp(ax.block) >= 0 {
			return false
		}
	}
	return true
}

// rankOf returns the lexicographic ordinal (last axis fastest) of a selected
// coordinate. The caller must have established membership with contains.
func (ps *preparedSel) rankOf(coord []*big.Int) *big.Int {
	ordinal := big.NewInt(0)
	for d, ax := range ps.axes {
		off := new(big.Int).Sub(coord[d], ax.start)
		i := new(big.Int).Quo(off, ax.stride)
		j := new(big.Int).Mul(i, ax.stride)
		j.Sub(off, j)
		// local axis index is i*block + j.
		local := new(big.Int).Mul(i, ax.block)
		local.Add(local, j)
		ordinal.Add(ordinal, new(big.Int).Mul(local, ax.suffix))
	}
	return ordinal
}

// unrank writes the coordinate with lexicographic ordinal ordinal into coord
// (which must have length rank) and returns it. ordinal must be in
// [0,total).
func (ps *preparedSel) unrank(ordinal *big.Int, coord []*big.Int) []*big.Int {
	rem := new(big.Int).Set(ordinal)
	for d, ax := range ps.axes {
		local := new(big.Int).Quo(rem, ax.suffix)
		rem.Rem(rem, ax.suffix)
		i := new(big.Int).Quo(local, ax.block)
		j := new(big.Int).Rem(local, ax.block)
		c := new(big.Int).Mul(i, ax.stride)
		c.Add(c, j)
		c.Add(c, ax.start)
		coord[d] = c
	}
	return coord
}
