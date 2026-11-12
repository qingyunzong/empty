package virtualarray

import (
	"math/big"
	"strconv"
	"strings"
)

// This file contains a deliberately simple, fully-expanded reference
// implementation. It is test-only and is only ever used for arrays small
// enough to enumerate every point, providing an independent oracle for the
// streaming membership/rank/unrank implementation.

func coordKey(coord []*big.Int) string {
	parts := make([]string, len(coord))
	for d, c := range coord {
		parts[d] = strconv.FormatInt(c.Int64(), 10)
	}
	return strings.Join(parts, ",")
}

// enumerateAxis returns every selected coordinate on one axis in order.
func enumerateAxis(ax AxisSel) []int64 {
	start := ax.Start.Int64()
	stride := ax.Stride.Int64()
	count := ax.Count.Int64()
	block := ax.Block.Int64()
	out := []int64{}
	for i := int64(0); i < count; i++ {
		for j := int64(0); j < block; j++ {
			out = append(out, start+i*stride+j)
		}
	}
	return out
}

// enumerateSelection returns every selected point in lexicographic order
// (last axis fastest).
func enumerateSelection(sel Selection) [][]int64 {
	axisPoints := make([][]int64, len(sel.Axes))
	for d, ax := range sel.Axes {
		axisPoints[d] = enumerateAxis(ax)
	}
	points := [][]int64{}
	current := make([]int64, len(sel.Axes))
	var walk func(d int)
	walk = func(d int) {
		if d == len(sel.Axes) {
			dup := make([]int64, len(current))
			copy(dup, current)
			points = append(points, dup)
			return
		}
		for _, v := range axisPoints[d] {
			current[d] = v
			walk(d + 1)
		}
	}
	walk(0)
	return points
}

type refPoint struct {
	mappingIndex int
	source       string
	order        Order
	sourceCoord  []int64
}

// referenceModel fully expands all mappings for a small array.
type referenceModel struct {
	virtualShape []int64
	fill         int64
	// win maps virtual coordinate key to the last covering mapping.
	win map[string]refPoint
}

func buildReference(virtualShape []int64, fill int64, mappings []Mapping, orders map[string]Order) *referenceModel {
	rm := &referenceModel{virtualShape: virtualShape, fill: fill, win: map[string]refPoint{}}
	for mi, m := range mappings {
		vpts := enumerateSelection(m.VirtualSel)
		spts := enumerateSelection(m.SourceSel)
		if len(vpts) != len(spts) {
			panic("reference: mismatched selection point counts")
		}
		for k, vp := range vpts {
			vBig := make([]*big.Int, len(vp))
			for d, v := range vp {
				vBig[d] = bi(v)
			}
			sc := make([]int64, len(spts[k]))
			copy(sc, spts[k])
			rm.win[coordKey(vBig)] = refPoint{
				mappingIndex: mi,
				source:       m.SourceName,
				order:        orders[m.SourceName],
				sourceCoord:  sc,
			}
		}
	}
	return rm
}

// refLinear computes a flattened index for small integer coordinates.
func refLinear(coord []int64, shape []int64, order Order) int64 {
	idx := int64(0)
	stride := int64(1)
	switch order {
	case FOrder:
		for d := 0; d < len(coord); d++ {
			idx += coord[d] * stride
			stride *= shape[d]
		}
	default:
		for d := len(coord) - 1; d >= 0; d-- {
			idx += coord[d] * stride
			stride *= shape[d]
		}
	}
	return idx
}

type refResult struct {
	values  []int64
	filled  []bool
	reasons []FillReason
	maps    []int
	source  []string
	scoord  [][]int64
}

// read runs the fully-expanded reference over a rectangle.
func (rm *referenceModel) read(r Rect, snap Snapshot, srcShapes map[string][]int64) refResult {
	rank := len(rm.virtualShape)
	lengths := make([]int64, rank)
	total := int64(1)
	for d := 0; d < rank; d++ {
		lengths[d] = r.Hi[d].Int64() - r.Lo[d].Int64()
		total *= lengths[d]
	}
	out := refResult{
		values:  make([]int64, total),
		filled:  make([]bool, total),
		reasons: make([]FillReason, total),
		maps:    make([]int, total),
		source:  make([]string, total),
		scoord:  make([][]int64, total),
	}
	coord := make([]int64, rank)
	for idx := int64(0); idx < total; idx++ {
		rem := idx
		for d := rank - 1; d >= 0; d-- {
			coord[d] = r.Lo[d].Int64() + rem%lengths[d]
			rem /= lengths[d]
		}
		bigCoord := make([]*big.Int, rank)
		for d, v := range coord {
			bigCoord[d] = bi(v)
		}
		out.maps[idx] = -1
		rp, ok := rm.win[coordKey(bigCoord)]
		if !ok {
			out.values[idx] = rm.fill
			out.filled[idx] = true
			out.reasons[idx] = NoMapping
			continue
		}
		out.maps[idx] = rp.mappingIndex
		out.source[idx] = rp.source
		if !snap[rp.source] {
			out.values[idx] = rm.fill
			out.filled[idx] = true
			out.reasons[idx] = SourceUnavailable
			continue
		}
		lin := refLinear(rp.sourceCoord, srcShapes[rp.source], rp.order)
		out.values[idx] = sourceValue(bi(lin))
		sc := make([]int64, len(rp.sourceCoord))
		copy(sc, rp.sourceCoord)
		out.scoord[idx] = sc
	}
	return out
}
