package virtualarray

import (
	"context"
	"math/big"
)

func bi(x int64) *big.Int { return big.NewInt(x) }

func newBig() *big.Int { return new(big.Int) }
func bigOne() *big.Int { return big.NewInt(1) }

// bigu builds a big.Int from an unsigned 64-bit value.
func bigu(x uint64) *big.Int { return new(big.Int).SetUint64(x) }

// shape builds a shape from int64 dimensions.
func shape(dims ...int64) []*big.Int {
	out := make([]*big.Int, len(dims))
	for d, v := range dims {
		out[d] = bi(v)
	}
	return out
}

// axis builds an AxisSel from plain integers.
func axis(start, stride, count, block int64) AxisSel {
	return AxisSel{Start: bi(start), Stride: bi(stride), Count: bi(count), Block: bi(block)}
}

// sel builds a Selection from per-axis selectors.
func sel(axes ...AxisSel) Selection { return Selection{Axes: axes} }

// rect builds a half-open Rect.
func rect(lo, hi []int64) Rect {
	r := Rect{Lo: make([]*big.Int, len(lo)), Hi: make([]*big.Int, len(hi))}
	for d := range lo {
		r.Lo[d] = bi(lo[d])
		r.Hi[d] = bi(hi[d])
	}
	return r
}

// hostSource is an in-memory flattened source. Values are deterministic and
// distinct per linear index even when the index exceeds int64 logic needs:
// value(lin) = (lin*7 + 13) reduced into the int64 range.
type hostSource struct {
	order Order
	shape []*big.Int
}

// host is a fake data-access host. It records every callback and the spans
// requested so tests can assert batching and single-read behavior.
type host struct {
	sources map[string]hostSource

	readCalls   int
	lastSpans   map[string][]Span
	failNext    bool
	wrongLength bool
}

func newHost() *host {
	return &host{sources: map[string]hostSource{}, lastSpans: map[string][]Span{}}
}

func (h *host) add(name string, order Order, dims ...int64) {
	h.sources[name] = hostSource{order: order, shape: shape(dims...)}
}

// sourceValue computes the raw stored value at a flattened index.
func sourceValue(lin *big.Int) int64 {
	v := new(big.Int).Mul(lin, big.NewInt(7))
	v.Add(v, big.NewInt(13))
	v.And(v, new(big.Int).SetInt64(-1)) // keep low 64 bits
	return v.Int64()
}

func (h *host) read(ctx context.Context, name string, spans []Span) ([]int64, error) {
	h.readCalls++
	h.lastSpans[name] = spans
	if h.failNext {
		h.failNext = false
		return nil, context.DeadlineExceeded
	}
	total := big.NewInt(0)
	for _, sp := range spans {
		total.Add(total, new(big.Int).Sub(sp.Hi, sp.Lo))
	}
	if h.wrongLength {
		return make([]int64, total.Int64()+1), nil
	}
	out := make([]int64, total.Int64())
	cursor := 0
	for _, sp := range spans {
		idx := new(big.Int).Set(sp.Lo)
		for idx.Cmp(sp.Hi) < 0 {
			out[cursor] = sourceValue(idx)
			cursor++
			idx.Add(idx, big.NewInt(1))
		}
	}
	return out, nil
}

// snapshot marks all known sources available.
func (h *host) snapshot(names ...string) Snapshot {
	snap := Snapshot{}
	for _, name := range names {
		snap[name] = true
	}
	return snap
}
