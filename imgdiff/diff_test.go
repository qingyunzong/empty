package imgdiff

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"math/rand"
	"reflect"
	"sort"
	"strings"
	"testing"
)

// testImage is a small in-memory image used to cross-check the
// interval logic byte by byte.
type testImage struct {
	size    int
	content []byte // logical bytes; holes read as zero
	alloc   []bool // per byte: true = data, false = hole
}

func (im testImage) byteAt(i int) byte {
	if i < 0 || i >= im.size || !im.alloc[i] {
		return 0
	}
	return im.content[i]
}

func (im testImage) dataAt(i int) bool {
	return i >= 0 && i < im.size && im.alloc[i]
}

// manifest builds a manifest from a test image, splitting data runs
// into digest extents on a global grid of grid bytes so that equal
// content always has equal digests.
func (im testImage) manifest(grid int) *Manifest {
	m := &Manifest{Size: uint64(im.size)}
	for s := 0; s < im.size; {
		e := s + 1
		for e < im.size && im.alloc[e] == im.alloc[s] {
			e++
		}
		if !im.alloc[s] {
			m.Extents = append(m.Extents, Extent{Start: uint64(s), End: uint64(e)})
			s = e
			continue
		}
		// Split the data run at grid boundaries.
		for c := s; c < e; {
			ce := min(e, (c/grid+1)*grid)
			chunk := im.content[c:ce]
			sum := sha256.Sum256(chunk)
			zero := true
			for _, b := range chunk {
				if b != 0 {
					zero = false
					break
				}
			}
			m.Extents = append(m.Extents, Extent{
				Start:  uint64(c),
				End:    uint64(ce),
				Data:   true,
				Digest: hex.EncodeToString(sum[:]),
				Zero:   zero,
			})
			c = ce
		}
		s = e
	}
	return m
}

// naiveDiff computes content and layout differences directly on the
// byte arrays, independently of the extent sweep under test.
func naiveDiff(a, b testImage) (content, layout []Interval) {
	size := max(a.size, b.size)
	var c, l []Interval
	for i := 0; i < size; i++ {
		if a.byteAt(i) != b.byteAt(i) {
			c = appendInterval(c, uint64(i), uint64(i+1))
		}
		da, db := a.dataAt(i), b.dataAt(i)
		if da != db || (da && db && a.byteAt(i) != b.byteAt(i)) {
			l = appendInterval(l, uint64(i), uint64(i+1))
		}
	}
	return c, l
}

// randImage builds a random small image with data runs, holes and
// zero-filled data blocks.
func randImage(r *rand.Rand, size int) testImage {
	im := testImage{size: size, content: make([]byte, size), alloc: make([]bool, size)}
	for i := 0; i < size; i++ {
		im.content[i] = byte(r.Intn(4)) // small alphabet: shared content is likely
	}
	i := 0
	for i < size {
		n := 1 + r.Intn(12)
		kind := r.Intn(4) // 0,1: data; 2: hole; 3: zero data block
		for j := i; j < min(size, i+n); j++ {
			switch kind {
			case 2:
				im.alloc[j] = false
				im.content[j] = 0
			case 3:
				im.alloc[j] = true
				im.content[j] = 0
			default:
				im.alloc[j] = true
			}
		}
		i += n
	}
	return im
}

// mutate derives a new image from an old one with random edits,
// keeping some shared content.
func mutate(r *rand.Rand, old testImage) testImage {
	n := old.size
	im := testImage{size: n, content: make([]byte, n), alloc: make([]bool, n)}
	copy(im.content, old.content)
	copy(im.alloc, old.alloc)
	for k := 0; k < 1+r.Intn(6); k++ {
		s := r.Intn(n)
		e := min(n, s+1+r.Intn(12))
		switch r.Intn(5) {
		case 0: // punch a hole
			for i := s; i < e; i++ {
				im.alloc[i] = false
				im.content[i] = 0
			}
		case 1: // overwrite with random data
			for i := s; i < e; i++ {
				im.alloc[i] = true
				im.content[i] = byte(r.Intn(4))
			}
		case 2: // allocate a zero data block
			for i := s; i < e; i++ {
				im.alloc[i] = true
				im.content[i] = 0
			}
		case 3: // copy a range elsewhere (may overlap)
			if n > 1 {
				dst := r.Intn(n)
				for i := s; i < e && dst+i-s < n; i++ {
					im.alloc[dst+i-s] = old.alloc[i]
					im.content[dst+i-s] = old.byteAt(i)
				}
			}
		case 4: // drop data, keep bytes (reads as hole)
			for i := s; i < e; i++ {
				im.alloc[i] = false
			}
		}
	}
	// Holes must read as zero.
	for i := 0; i < n; i++ {
		if !im.alloc[i] {
			im.content[i] = 0
		}
	}
	return im
}

func diffViaManifests(a, b testImage, grid int) (content, layout []Interval) {
	ma := a.manifest(grid)
	mb := b.manifest(grid)
	fa, err := ma.Flatten()
	if err != nil {
		panic(err)
	}
	fb, err := mb.Flatten()
	if err != nil {
		panic(err)
	}
	return Diff(fa, ma.Size, fb, mb.Size)
}

// TestDiffAgainstByteArrays cross-checks the sweep against a naive
// per-byte comparison on small byte arrays. Digests are per byte
// (grid 1), so digest equality is exactly byte equality.
func TestDiffAgainstByteArrays(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	for iter := 0; iter < 400; iter++ {
		sizeA := 1 + r.Intn(120)
		sizeB := sizeA
		if r.Intn(4) == 0 {
			sizeB = 1 + r.Intn(120) // sometimes different sizes
		}
		a := randImage(r, sizeA)
		b := mutate(r, a)
		if sizeB != sizeA {
			b = randImage(r, sizeB)
		}
		gotC, gotL := diffViaManifests(a, b, 1)
		wantC, wantL := naiveDiff(a, b)
		if !reflect.DeepEqual(gotC, wantC) {
			t.Fatalf("iter %d: content diff\n got %v\nwant %v", iter, gotC, wantC)
		}
		if !reflect.DeepEqual(gotL, wantL) {
			t.Fatalf("iter %d: layout diff\n got %v\nwant %v", iter, gotL, wantL)
		}
	}
}

// TestDiffSweepAgainstBruteForce checks the interval sweep against an
// independent quadratic evaluation of every elementary segment, with
// multi-byte extents (grid > 1).
func TestDiffSweepAgainstBruteForce(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	for iter := 0; iter < 300; iter++ {
		sizeA := 1 + r.Intn(120)
		sizeB := sizeA
		if r.Intn(4) == 0 {
			sizeB = 1 + r.Intn(120)
		}
		grid := 1 + r.Intn(8)
		a := randImage(r, sizeA)
		b := mutate(r, a)
		if sizeB != sizeA {
			b = randImage(r, sizeB)
		}
		gotC, gotL := diffViaManifests(a, b, grid)
		wantC, wantL := bruteDiff(a.manifest(grid), b.manifest(grid))
		if !reflect.DeepEqual(gotC, wantC) {
			t.Fatalf("iter %d: content diff\n got %v\nwant %v", iter, gotC, wantC)
		}
		if !reflect.DeepEqual(gotL, wantL) {
			t.Fatalf("iter %d: layout diff\n got %v\nwant %v", iter, gotL, wantL)
		}
	}
}

// bruteDiff is an independent, deliberately simple O(n^2) evaluation
// of the diff semantics: it walks every elementary segment and scans
// the extent lists linearly.
func bruteDiff(ma, mb *Manifest) (content, layout []Interval) {
	fa, err := ma.Flatten()
	if err != nil {
		panic(err)
	}
	fb, err := mb.Flatten()
	if err != nil {
		panic(err)
	}
	size := ma.Size
	if mb.Size > size {
		size = mb.Size
	}
	bset := map[uint64]bool{0: true, size: true}
	for _, e := range fa {
		bset[e.Start], bset[e.End] = true, true
	}
	for _, e := range fb {
		bset[e.Start], bset[e.End] = true, true
	}
	var bounds []uint64
	for b := range bset {
		bounds = append(bounds, b)
	}
	sort.Slice(bounds, func(i, j int) bool { return bounds[i] < bounds[j] })
	stateAt := func(flat []Extent, pos uint64) (data, zero bool, digest string) {
		for _, e := range flat {
			if e.Data && e.Start <= pos && pos < e.End {
				return true, e.Zero, e.Digest
			}
		}
		return false, false, ""
	}
	var c, l []Interval
	for i := 0; i+1 < len(bounds); i++ {
		lo, hi := bounds[i], bounds[i+1]
		da, za, ga := stateAt(fa, lo)
		db, zb, gb := stateAt(fb, lo)
		aZero := !da || za
		bZero := !db || zb
		contentEq := (aZero && bZero) || (da && db && !za && !zb && ga == gb)
		layoutEq := da == db && (!da || contentEq)
		if !contentEq {
			c = appendInterval(c, lo, hi)
		}
		if !layoutEq {
			l = appendInterval(l, lo, hi)
		}
	}
	return c, l
}

func TestDiffZeroBlockVsHole(t *testing.T) {
	hole := &Manifest{Size: 8, Extents: []Extent{{Start: 0, End: 8}}}
	zero := &Manifest{Size: 8, Extents: []Extent{
		{Start: 0, End: 8, Data: true, Digest: "zeros", Zero: true},
	}}
	fa, _ := hole.Flatten()
	fb, _ := zero.Flatten()
	content, layout := Diff(fa, 8, fb, 8)
	if len(content) != 0 {
		t.Fatalf("zero block vs hole must have equal content, got %v", content)
	}
	want := []Interval{{Start: 0, End: 8}}
	if !reflect.DeepEqual(layout, want) {
		t.Fatalf("zero block vs hole must differ in layout: got %v want %v", layout, want)
	}
}

func TestDiffMaximalIntervals(t *testing.T) {
	// Differences separated by one equal byte must not merge; adjacent
	// ones must merge into a single maximal interval.
	mk := func(digest string) *Manifest {
		return &Manifest{Size: 6, Extents: []Extent{
			{Start: 0, End: 6, Data: true, Digest: digest},
		}}
	}
	a := mk("aaa")
	b := &Manifest{Size: 6, Extents: []Extent{
		{Start: 0, End: 2, Data: true, Digest: "bbb"},
		{Start: 2, End: 3, Data: true, Digest: "aaa"},
		{Start: 3, End: 6, Data: true, Digest: "ccc"},
	}}
	fa, _ := a.Flatten()
	fb, _ := b.Flatten()
	content, layout := Diff(fa, 6, fb, 6)
	want := []Interval{{Start: 0, End: 2}, {Start: 3, End: 6}}
	if !reflect.DeepEqual(content, want) {
		t.Fatalf("content diff got %v want %v", content, want)
	}
	if !reflect.DeepEqual(layout, want) {
		t.Fatalf("layout diff got %v want %v", layout, want)
	}
}

func TestBoundsRejected(t *testing.T) {
	cases := []struct {
		name string
		m    *Manifest
		want string
	}{
		{"end beyond size", &Manifest{Size: 4, Extents: []Extent{{Start: 0, End: 5, Data: true, Digest: "x"}}}, "exceeds image size"},
		{"end before start", &Manifest{Size: 8, Extents: []Extent{{Start: 5, End: 2, Data: true, Digest: "x"}}}, "end 2 < start 5"},
		{"empty extent", &Manifest{Size: 8, Extents: []Extent{{Start: 3, End: 3}}}, "empty interval"},
		{"overlap", &Manifest{Size: 8, Extents: []Extent{
			{Start: 0, End: 4, Data: true, Digest: "x"},
			{Start: 3, End: 6, Data: true, Digest: "y"},
		}}, "overlaps"},
		{"parent out of bounds", &Manifest{Size: 4, Parent: &Manifest{
			Size:    2,
			Extents: []Extent{{Start: 0, End: 3, Data: true, Digest: "x"}},
		}}, "exceeds image size"},
	}
	for _, tc := range cases {
		if _, err := tc.m.Flatten(); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want error containing %q", tc.name, err, tc.want)
		}
	}
}

func TestParentInheritance(t *testing.T) {
	grand := &Manifest{Size: 16, Extents: []Extent{
		{Start: 0, End: 8, Data: true, Digest: "g"},
	}}
	parent := &Manifest{Size: 16, Parent: grand, Extents: []Extent{
		{Start: 4, End: 12, Data: true, Digest: "p"},
	}}
	child := &Manifest{Size: 16, Parent: parent, Extents: []Extent{
		{Start: 2, End: 6, Data: true, Digest: "c"},
		{Start: 10, End: 14, Data: true, Digest: "c2"},
	}}
	flat, err := child.Flatten()
	if err != nil {
		t.Fatal(err)
	}
	want := []Extent{
		{Start: 0, End: 2, Data: true, Digest: "g"},
		{Start: 2, End: 6, Data: true, Digest: "c"},
		{Start: 6, End: 10, Data: true, Digest: "p"},
		{Start: 10, End: 14, Data: true, Digest: "c2"},
	}
	if !reflect.DeepEqual(flat, want) {
		t.Fatalf("flatten got %+v want %+v", flat, want)
	}
}

func TestParentClippedToChildSize(t *testing.T) {
	parent := &Manifest{Size: 16, Extents: []Extent{
		{Start: 0, End: 16, Data: true, Digest: "p"},
	}}
	child := &Manifest{Size: 6, Parent: parent}
	flat, err := child.Flatten()
	if err != nil {
		t.Fatal(err)
	}
	want := []Extent{{Start: 0, End: 6, Data: true, Digest: "p"}}
	if !reflect.DeepEqual(flat, want) {
		t.Fatalf("got %+v want %+v", flat, want)
	}
}

func TestUint64Offsets(t *testing.T) {
	top := uint64(math.MaxUint64)
	a := &Manifest{Size: top, Extents: []Extent{
		{Start: 1 << 63, End: top, Data: true, Digest: "x"},
	}}
	b := &Manifest{Size: top, Extents: []Extent{
		{Start: 1 << 63, End: top - 100, Data: true, Digest: "x"},
		{Start: top - 100, End: top},
	}}
	fa, err := a.Flatten()
	if err != nil {
		t.Fatal(err)
	}
	fb, err := b.Flatten()
	if err != nil {
		t.Fatal(err)
	}
	content, layout := Diff(fa, a.Size, fb, b.Size)
	want := []Interval{{Start: top - 100, End: top}}
	// Non-zero data vs hole differs in both content and layout.
	if !reflect.DeepEqual(content, want) {
		t.Fatalf("content got %v want %v", content, want)
	}
	if !reflect.DeepEqual(layout, want) {
		t.Fatalf("layout got %v want %v", layout, want)
	}
}
