package dataeng

import (
	"math/rand"
	"sort"
	"testing"
)

func referenceSorted(d Domain, r Rect) []Interval {
	codes := make([]uint32, 0, int(r.Width())*int(r.Height()))
	for y := r.MinY; y <= r.MaxY; y++ {
		for x := r.MinX; x <= r.MaxX; x++ {
			codes = append(codes, interleave(x, y, d.Bits))
		}
	}
	sort.Slice(codes, func(i, j int) bool { return codes[i] < codes[j] })
	var out []Interval
	for _, code := range codes {
		if len(out) > 0 && out[len(out)-1].Hi == code {
			out[len(out)-1].Hi = code + 1
			continue
		}
		out = append(out, Interval{Lo: code, Hi: code + 1})
	}
	return out
}

func TestRandomRectsThroughB12(t *testing.T) {
	rng := rand.New(rand.NewSource(20261112))
	for bits := 6; bits <= 12; bits++ {
		d := mustDomain(t, bits)
		size := int(d.Size())
		for i := 0; i < 300; i++ {
			w := 1 + rng.Intn(40)
			h := 1 + rng.Intn(40)
			x0 := rng.Intn(size - w + 1)
			y0 := rng.Intn(size - h + 1)
			r := Rect{
				MinX: uint32(x0), MaxX: uint32(x0 + w - 1),
				MinY: uint32(y0), MaxY: uint32(y0 + h - 1),
			}
			res, err := d.Query(r, int(d.CodeCount()))
			if err != nil {
				t.Fatalf("b=%d %+v: %v", bits, r, err)
			}
			want := referenceSorted(d, r)
			if !sameRanges(res.Intervals, want) {
				t.Fatalf("b=%d rect %+v:\n got %s\nwant %s",
					bits, r, ranges(res.Intervals), ranges(want))
			}
			if err := d.Verify(r, res); err != nil {
				t.Fatalf("b=%d %+v Verify: %v", bits, r, err)
			}
			if i == 0 && len(want) > 1 {
				budget := len(want) / 2
				part, err := d.Query(r, budget)
				if err != nil {
					t.Fatal(err)
				}
				if part.Complete || !sameRanges(part.Intervals, want[:budget]) {
					t.Fatalf("b=%d %+v budget=%d partial mismatch", bits, r, budget)
				}
				if err := d.Verify(r, part); err != nil {
					t.Fatalf("b=%d %+v partial Verify: %v", bits, r, err)
				}
			}
		}
	}
}
