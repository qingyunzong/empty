package imgdiff

import (
	"math/rand"
	"reflect"
	"testing"
)

// expand renders an image as a flat byte slice of n bytes (holes and
// beyond-size read as zeros). Independent reference for small tests.
func expand(img *Image, n uint64) []byte {
	out := make([]byte, n)
	for _, e := range img.Extents {
		if e.Kind != Data {
			continue
		}
		for i := uint64(0); i < e.Len; i++ {
			if p := e.Start + i; p < n {
				out[p] = e.Data[i]
			}
		}
	}
	return out
}

// layoutOf renders the data/hole classification as a bool slice.
func layoutOf(img *Image, n uint64) []bool {
	out := make([]bool, n) // false = hole
	for _, e := range img.Extents {
		if e.Kind != Data {
			continue
		}
		for p := e.Start; p < e.End() && p < n; p++ {
			out[p] = true
		}
	}
	return out
}

// mergeDiffs scans per-position differences into maximal half-open
// intervals. Independent reference implementation.
func mergeDiffs(diff func(i uint64) bool, n uint64) []Interval {
	var out []Interval
	for i := uint64(0); i < n; i++ {
		if !diff(i) {
			continue
		}
		if len(out) > 0 && out[len(out)-1].End == i {
			out[len(out)-1].End = i + 1
		} else {
			out = append(out, Interval{Start: i, End: i + 1})
		}
	}
	return out
}

// refContentDiff brute-forces content diff over expanded byte arrays.
func refContentDiff(a, b *Image) []Interval {
	n := a.Size
	if b.Size > n {
		n = b.Size
	}
	ea, eb := expand(a, n), expand(b, n)
	return mergeDiffs(func(i uint64) bool { return ea[i] != eb[i] }, n)
}

// refLayoutDiff brute-forces layout diff over classification arrays.
func refLayoutDiff(a, b *Image) []Interval {
	n := a.Size
	if b.Size > n {
		n = b.Size
	}
	la, lb := layoutOf(a, n), layoutOf(b, n)
	return mergeDiffs(func(i uint64) bool { return la[i] != lb[i] }, n)
}

func dataExt(start uint64, data []byte) Extent {
	return Extent{Start: start, Len: uint64(len(data)), Kind: Data, Data: data}
}

func holeExt(start, length uint64) Extent {
	return Extent{Start: start, Len: length, Kind: Hole}
}

func TestContentDiffTargeted(t *testing.T) {
	cases := []struct {
		name string
		a, b *Image
		want []Interval
	}{
		{
			name: "identical",
			a:    &Image{Size: 4, Extents: []Extent{dataExt(0, []byte{1, 2, 3, 4})}},
			b:    &Image{Size: 4, Extents: []Extent{dataExt(0, []byte{1, 2, 3, 4})}},
			want: nil,
		},
		{
			name: "zero data block vs hole is content equal",
			a:    &Image{Size: 4, Extents: []Extent{dataExt(0, []byte{0, 0, 0, 0})}},
			b:    &Image{Size: 4, Extents: []Extent{holeExt(0, 4)}},
			want: nil,
		},
		{
			name: "single byte",
			a:    &Image{Size: 4, Extents: []Extent{dataExt(0, []byte{1, 2, 3, 4})}},
			b:    &Image{Size: 4, Extents: []Extent{dataExt(0, []byte{1, 9, 3, 4})}},
			want: []Interval{{1, 2}},
		},
		{
			name: "adjacent diffs merge into maximal interval",
			a:    &Image{Size: 8, Extents: []Extent{dataExt(0, []byte{1, 1, 1, 1}), dataExt(4, []byte{2, 2, 2, 2})}},
			b:    &Image{Size: 8, Extents: []Extent{dataExt(0, []byte{9, 9, 9, 9}), dataExt(4, []byte{8, 8, 8, 8})}},
			want: []Interval{{0, 8}},
		},
		{
			name: "diffs separated by equal bytes stay separate",
			a:    &Image{Size: 6, Extents: []Extent{dataExt(0, []byte{1, 2, 3, 4, 5, 6})}},
			b:    &Image{Size: 6, Extents: []Extent{dataExt(0, []byte{9, 2, 3, 4, 5, 9})}},
			want: []Interval{{0, 1}, {5, 6}},
		},
		{
			name: "size mismatch: tail of larger image vs zeros",
			a:    &Image{Size: 2, Extents: []Extent{dataExt(0, []byte{1, 2})}},
			b:    &Image{Size: 6, Extents: []Extent{dataExt(0, []byte{1, 2}), dataExt(4, []byte{7, 7})}},
			want: []Interval{{4, 6}},
		},
		{
			name: "size mismatch: zero tail is content equal",
			a:    &Image{Size: 2, Extents: []Extent{dataExt(0, []byte{1, 2})}},
			b:    &Image{Size: 6, Extents: []Extent{dataExt(0, []byte{1, 2}), holeExt(2, 4)}},
			want: nil,
		},
		{
			name: "hole vs nonzero data",
			a:    &Image{Size: 4, Extents: []Extent{holeExt(0, 4)}},
			b:    &Image{Size: 4, Extents: []Extent{dataExt(1, []byte{5, 5})}},
			want: []Interval{{1, 3}},
		},
		{
			name: "empty images",
			a:    &Image{Size: 0},
			b:    &Image{Size: 0},
			want: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := ContentDiff(tc.a, tc.b)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			if ref := refContentDiff(tc.a, tc.b); !reflect.DeepEqual(got, ref) {
				t.Fatalf("got %v, reference %v", got, ref)
			}
		})
	}
}

func TestLayoutDiffTargeted(t *testing.T) {
	cases := []struct {
		name string
		a, b *Image
		want []Interval
	}{
		{
			name: "zero data block vs hole is layout different",
			a:    &Image{Size: 4, Extents: []Extent{dataExt(0, []byte{0, 0, 0, 0})}},
			b:    &Image{Size: 4, Extents: []Extent{holeExt(0, 4)}},
			want: []Interval{{0, 4}},
		},
		{
			name: "same layout different content is layout equal",
			a:    &Image{Size: 4, Extents: []Extent{dataExt(0, []byte{1, 2, 3, 4})}},
			b:    &Image{Size: 4, Extents: []Extent{dataExt(0, []byte{9, 9, 9, 9})}},
			want: nil,
		},
		{
			name: "partial overlap merges",
			a:    &Image{Size: 8, Extents: []Extent{dataExt(0, []byte{1, 1, 1, 1}), holeExt(4, 4)}},
			b:    &Image{Size: 8, Extents: []Extent{holeExt(0, 2), dataExt(2, []byte{1, 1}), holeExt(4, 4)}},
			want: []Interval{{0, 2}},
		},
		{
			name: "size mismatch: data tail is layout different",
			a:    &Image{Size: 2, Extents: []Extent{dataExt(0, []byte{1, 2})}},
			b:    &Image{Size: 6, Extents: []Extent{dataExt(0, []byte{1, 2}), holeExt(2, 2), dataExt(4, []byte{0, 0})}},
			want: []Interval{{4, 6}},
		},
		{
			name: "shared and private data have same layout",
			a:    &Image{Size: 2, Extents: []Extent{{Start: 0, Len: 2, Kind: Data, Shared: true, Data: []byte{1, 2}}}},
			b:    &Image{Size: 2, Extents: []Extent{dataExt(0, []byte{1, 2})}},
			want: nil,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := LayoutDiff(tc.a, tc.b)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			if ref := refLayoutDiff(tc.a, tc.b); !reflect.DeepEqual(got, ref) {
				t.Fatalf("got %v, reference %v", got, ref)
			}
		})
	}
}

// randImage builds a random small image from the given alphabet of extent
// byte patterns, with holes and gaps.
func randImage(r *rand.Rand, maxSize uint64) *Image {
	size := r.Uint64() % (maxSize + 1)
	img := &Image{Size: size}
	pos := uint64(0)
	for pos < size {
		length := 1 + r.Uint64()%8
		if pos+length > size {
			length = size - pos
		}
		switch r.Intn(3) {
		case 0: // gap (implicit hole)
		case 1: // explicit hole
			img.Extents = append(img.Extents, holeExt(pos, length))
		default: // data, often zero-filled to collide with holes in content
			b := make([]byte, length)
			if r.Intn(2) == 0 {
				for i := range b {
					b[i] = byte(r.Intn(4))
				}
			}
			img.Extents = append(img.Extents, dataExt(pos, b))
		}
		pos += length
	}
	return img
}

func TestDiffRandomCrossCheck(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	for trial := 0; trial < 2000; trial++ {
		a, b := randImage(r, 48), randImage(r, 48)
		gotC, err := ContentDiff(a, b)
		if err != nil {
			t.Fatal(err)
		}
		if ref := refContentDiff(a, b); !reflect.DeepEqual(gotC, ref) {
			t.Fatalf("trial %d content:\n a=%+v\n b=%+v\n got %v\n ref %v", trial, a.Extents, b.Extents, gotC, ref)
		}
		gotL, err := LayoutDiff(a, b)
		if err != nil {
			t.Fatal(err)
		}
		if ref := refLayoutDiff(a, b); !reflect.DeepEqual(gotL, ref) {
			t.Fatalf("trial %d layout:\n a=%+v\n b=%+v\n got %v\n ref %v", trial, a.Extents, b.Extents, gotL, ref)
		}
	}
}

func TestValidateRejectsBadIntervals(t *testing.T) {
	cases := []struct {
		name string
		img  *Image
	}{
		{"overflow", &Image{Size: 10, Extents: []Extent{{Start: ^uint64(0) - 3, Len: 8, Kind: Hole}}}},
		{"out of range", &Image{Size: 4, Extents: []Extent{holeExt(2, 4)}}},
		{"zero length", &Image{Size: 4, Extents: []Extent{{Start: 0, Len: 0, Kind: Hole}}}},
		{"overlap", &Image{Size: 8, Extents: []Extent{holeExt(0, 4), holeExt(2, 2)}}},
		{"unsorted", &Image{Size: 8, Extents: []Extent{holeExt(4, 4), holeExt(0, 2)}}},
		{"data length mismatch", &Image{Size: 4, Extents: []Extent{{Start: 0, Len: 4, Kind: Data, Data: []byte{1, 2}}}}},
		{"hole carries data", &Image{Size: 4, Extents: []Extent{{Start: 0, Len: 2, Kind: Hole, Data: []byte{0, 0}}}}},
		{"shared hole", &Image{Size: 4, Extents: []Extent{{Start: 0, Len: 2, Kind: Hole, Shared: true}}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.img.Validate(); err == nil {
				t.Fatalf("extent list accepted, want rejection")
			}
			if _, err := ContentDiff(tc.img, &Image{Size: 4}); err == nil {
				t.Fatalf("ContentDiff accepted invalid image")
			}
			if _, err := LayoutDiff(&Image{Size: 4}, tc.img); err == nil {
				t.Fatalf("LayoutDiff accepted invalid image")
			}
		})
	}
}
