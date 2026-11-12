package dataeng_test

import (
	"errors"
	"fmt"
	"math/big"
	"reflect"
	"strconv"
	"strings"
	"testing"

	de "example.org/dataeng/q0298"
	"example.org/dataeng/q0298/internal/refexp"
)

func descriptor(t *testing.T, f, x, y int) de.Descriptor {
	t.Helper()
	d, err := de.NewDescriptor(f, x, y)
	if err != nil {
		t.Fatalf("NewDescriptor(%d,%d,%d): %v", f, x, y, err)
	}
	return d
}

func element(t *testing.T, name string, width, scale int, reference string) de.ElementDef {
	t.Helper()
	ref, ok := new(big.Int).SetString(reference, 10)
	if !ok {
		t.Fatalf("bad reference %q", reference)
	}
	def, err := de.NewElementDef(name, width, scale, ref)
	if err != nil {
		t.Fatalf("NewElementDef(%s): %v", name, err)
	}
	return def
}

func elementTable(t *testing.T, entries map[de.ElementKey]de.ElementDef) de.ElementTable {
	t.Helper()
	for key, def := range entries {
		if err := def.Validate(); err != nil {
			t.Fatalf("element %v: %v", key, err)
		}
	}
	return entries
}

func field(t *testing.T, width int, value uint64) string {
	t.Helper()
	if width < 0 || width > 64 {
		t.Fatalf("bad field width %d", width)
	}
	if width == 64 {
		s := strconv.FormatUint(value, 2)
		return strings.Repeat("0", 64-len(s)) + s
	}
	if value > (uint64(1)<<uint(width))-1 {
		t.Fatalf("value %d does not fit %d bits", value, width)
	}
	s := strconv.FormatUint(value, 2)
	return strings.Repeat("0", width-len(s)) + s
}

func stream(t *testing.T, fields ...string) de.BitString {
	t.Helper()
	b, err := de.NewBitString(strings.Join(fields, ""))
	if err != nil {
		t.Fatalf("NewBitString: %v", err)
	}
	return b
}

func mustCompile(t *testing.T, root []de.Descriptor, elements de.ElementTable, sequences de.SequenceTable) *de.Template {
	t.Helper()
	tmpl, err := de.Compile(root, elements, sequences)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	return tmpl
}

func mustDecode(t *testing.T, tmpl *de.Template, bits de.BitString, options de.DecodeOptions) []de.Observation {
	t.Helper()
	obs, err := tmpl.Decode(bits, options)
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	return obs
}

func TestNestedDelayedReplicationAndLimits(t *testing.T) {
	A := element(t, "A", 8, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
	})
	root := []de.Descriptor{
		descriptor(t, 1, 3, 0),
		descriptor(t, 0, 31, 1),
		descriptor(t, 1, 1, 0),
		descriptor(t, 0, 31, 2),
		descriptor(t, 0, 1, 1),
	}
	tmpl := mustCompile(t, root, elements, nil)

	var bits []string
	bits = append(bits, field(t, 8, 2))
	raws := []uint64{11, 12, 13, 21, 22, 23}
	for outer := 0; outer < 2; outer++ {
		bits = append(bits, field(t, 16, 3))
		for inner := 0; inner < 3; inner++ {
			bits = append(bits, field(t, 8, raws[outer*3+inner]))
		}
	}
	obs := mustDecode(t, tmpl, stream(t, bits...), de.DecodeOptions{
		Subsets:         1,
		MaxObservations: -1,
		MaxSteps:        12,
		MaxDepth:        2,
	})
	if len(obs) != 6 {
		t.Fatalf("got %d observations, want 6", len(obs))
	}

	bitStart := 24 // first outer factor is 8 bits, then each inner factor is 16 bits.
	for i, got := range obs {
		if i == 3 {
			bitStart += 16 // the second outer iteration's factor.
		}
		outer, inner := i/3+1, i%3+1
		wantPath := []de.PathStep{
			{Kind: de.PathReplication, Descriptor: root[0], Iteration: outer},
			{Kind: de.PathReplication, Descriptor: root[2], Iteration: inner},
		}
		if !reflect.DeepEqual(got.Path, wantPath) {
			t.Fatalf("obs %d path = %#v, want %#v", i, got.Path, wantPath)
		}
		if got.BitStart != bitStart || got.BitEnd != bitStart+8 || got.Raw != raws[i] {
			t.Fatalf("obs %d range/raw = [%d,%d)/%d, want [%d,%d)/%d",
				i, got.BitStart, got.BitEnd, got.Raw, bitStart, bitStart+8, raws[i])
		}
		bitStart += 8
	}

	for _, tc := range []struct {
		name string
		opt  de.DecodeOptions
		want error
	}{
		{"steps", de.DecodeOptions{Subsets: 1, MaxObservations: -1, MaxSteps: 11, MaxDepth: 2}, de.ErrStepLimit},
		{"depth", de.DecodeOptions{Subsets: 1, MaxObservations: -1, MaxSteps: 100, MaxDepth: 1}, de.ErrDepthLimit},
	} {
		failed, err := tmpl.Decode(stream(t, bits...), tc.opt)
		if err == nil || !errors.Is(err, tc.want) {
			t.Fatalf("%s: err=%v, want errors.Is(%v)", tc.name, err, tc.want)
		}
		if failed != nil {
			t.Fatalf("%s: partial observations published: %#v", tc.name, failed)
		}
	}

	// Cross-check the production paths against the independent small reference
	// expander on the same nested delayed template.
	counts := []uint64{2, 3, 3}
	next := 0
	leaves, err := refexp.Expand(root, elements, nil, refexp.Options{
		MaxLeaves: 6,
		MaxDepth:  2,
		Factor: func(int) (uint64, error) {
			v := counts[next]
			next++
			return v, nil
		},
	})
	if err != nil {
		t.Fatalf("reference expansion: %v", err)
	}
	if len(leaves) != len(obs) {
		t.Fatalf("reference leaves=%d production observations=%d", len(leaves), len(obs))
	}
	for i := range obs {
		if leaves[i].Descriptor != obs[i].Element.Descriptor() {
			t.Fatalf("leaf %d descriptor=%s, production=%s", i, leaves[i].Descriptor, obs[i].Element.Descriptor())
		}
		if len(leaves[i].Path) != len(obs[i].Path) {
			t.Fatalf("leaf %d path lengths differ", i)
		}
		for j := range leaves[i].Path {
			if leaves[i].Path[j].Kind != obs[i].Path[j].Kind ||
				leaves[i].Path[j].Descriptor != obs[i].Path[j].Descriptor ||
				leaves[i].Path[j].Iteration != obs[i].Path[j].Iteration {
				t.Fatalf("leaf %d path step %d differs: %#v vs %#v", i, j, leaves[i].Path[j], obs[i].Path[j])
			}
		}
	}
}

func TestReplicationXCountsRawPositionsNotExpandedLeaves(t *testing.T) {
	A := element(t, "A", 8, 0, "0")
	B := element(t, "B", 8, 0, "0")
	C := element(t, "C", 8, 0, "0")
	D := element(t, "D", 8, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
		{X: 1, Y: 2}: B,
		{X: 1, Y: 3}: C,
		{X: 2, Y: 1}: D,
	})
	seqDesc := descriptor(t, 3, 1, 1)
	sequences := de.SequenceTable{
		{X: 1, Y: 1}: {
			descriptor(t, 0, 1, 1),
			descriptor(t, 0, 1, 2),
			descriptor(t, 0, 1, 3),
		},
	}
	root := []de.Descriptor{
		descriptor(t, 1, 2, 2),
		seqDesc,
		descriptor(t, 0, 2, 1),
	}
	tmpl := mustCompile(t, root, elements, sequences)

	var fields []string
	raw := uint64(1)
	for i := 0; i < 8; i++ {
		fields = append(fields, field(t, 8, raw))
		raw++
	}
	obs := mustDecode(t, tmpl, stream(t, fields...), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 20, MaxDepth: 2,
	})
	if len(obs) != 8 {
		t.Fatalf("X=2 body with a sequence expanded to %d leaves, want 8", len(obs))
	}
	for i, got := range obs {
		iteration := i/4 + 1
		if got.Path[0] != (de.PathStep{Kind: de.PathReplication, Descriptor: root[0], Iteration: iteration}) {
			t.Fatalf("obs %d first path step = %#v", i, got.Path[0])
		}
		if i%4 < 3 {
			wantSeq := de.PathStep{Kind: de.PathSequence, Descriptor: seqDesc}
			if got.Path[1] != wantSeq {
				t.Fatalf("obs %d sequence path = %#v, want %#v", i, got.Path[1], wantSeq)
			}
		} else if len(got.Path) != 1 {
			t.Fatalf("obs %d direct element path = %#v", i, got.Path)
		}
	}
}

func TestSequenceOperatorLeaksOutside(t *testing.T) {
	A := element(t, "A", 8, 0, "0")
	B := element(t, "B", 8, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
		{X: 1, Y: 2}: B,
	})
	seqDesc := descriptor(t, 3, 1, 1)
	sequences := de.SequenceTable{
		{X: 1, Y: 1}: {
			descriptor(t, 2, 1, 129),
			descriptor(t, 0, 1, 1),
		},
	}
	root := []de.Descriptor{seqDesc, descriptor(t, 0, 1, 2)}
	tmpl := mustCompile(t, root, elements, sequences)
	obs := mustDecode(t, tmpl, stream(t, field(t, 9, 10), field(t, 9, 20)), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 10, MaxDepth: 1,
	})
	if len(obs) != 2 {
		t.Fatalf("got %d observations", len(obs))
	}
	if obs[0].BitEnd-obs[0].BitStart != 9 {
		t.Fatalf("A width = %d, want 9", obs[0].BitEnd-obs[0].BitStart)
	}
	if obs[1].BitEnd-obs[1].BitStart != 9 {
		t.Fatalf("B width outside sequence = %d, want 9 (operator must not restore)", obs[1].BitEnd-obs[1].BitStart)
	}
}

func TestOperatorSetsRatherThanAccumulates(t *testing.T) {
	A := element(t, "A", 8, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
	})
	root := []de.Descriptor{
		descriptor(t, 2, 1, 129),
		descriptor(t, 2, 1, 129),
		descriptor(t, 0, 1, 1),
	}
	tmpl := mustCompile(t, root, elements, nil)
	obs := mustDecode(t, tmpl, stream(t, field(t, 9, 1)), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 10, MaxDepth: 0,
	})
	if len(obs) != 1 || obs[0].BitEnd-obs[0].BitStart != 9 {
		t.Fatalf("width=%d, want 9 (second operator sets, does not add)", obs[0].BitEnd-obs[0].BitStart)
	}
}

func TestReplicationIterationsContinueOffsetState(t *testing.T) {
	A := element(t, "A", 8, 0, "0")
	B := element(t, "B", 8, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
		{X: 1, Y: 2}: B,
	})
	root := []de.Descriptor{
		descriptor(t, 1, 2, 2),
		descriptor(t, 0, 1, 1),
		descriptor(t, 2, 1, 129),
		descriptor(t, 0, 1, 2),
	}
	tmpl := mustCompile(t, root, elements, nil)
	obs := mustDecode(t, tmpl, stream(t, field(t, 8, 1), field(t, 9, 2), field(t, 9, 3)), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 20, MaxDepth: 1,
	})
	if len(obs) != 3 {
		t.Fatalf("got %d observations, want 3", len(obs))
	}
	if obs[0].BitEnd-obs[0].BitStart != 8 {
		t.Fatalf("first A width=%d, want 8", obs[0].BitEnd-obs[0].BitStart)
	}
	if obs[1].BitEnd-obs[1].BitStart != 9 {
		t.Fatalf("second A width=%d, want 9 (state continues between iterations)", obs[1].BitEnd-obs[1].BitStart)
	}
	if obs[2].BitEnd-obs[2].BitStart != 9 {
		t.Fatalf("B width after replication=%d, want 9 (state not restored)", obs[2].BitEnd-obs[2].BitStart)
	}
}

func TestOperatorZeroClearsOffsets(t *testing.T) {
	A := element(t, "A", 8, 0, "0")
	B := element(t, "B", 8, 0, "0")
	C := element(t, "C", 8, 0, "0")
	D := element(t, "D", 8, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
		{X: 1, Y: 2}: B,
		{X: 1, Y: 3}: C,
		{X: 1, Y: 4}: D,
	})
	root := []de.Descriptor{
		descriptor(t, 2, 1, 130),
		descriptor(t, 0, 1, 1),
		descriptor(t, 2, 1, 0),
		descriptor(t, 0, 1, 2),
		descriptor(t, 2, 2, 130),
		descriptor(t, 0, 1, 3),
		descriptor(t, 2, 2, 0),
		descriptor(t, 0, 1, 4),
	}
	tmpl := mustCompile(t, root, elements, nil)
	bits := stream(t,
		field(t, 10, 1),
		field(t, 8, 2),
		field(t, 8, 3),
		field(t, 8, 4),
	)
	obs := mustDecode(t, tmpl, bits, de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 20, MaxDepth: 0,
	})
	if len(obs) != 4 {
		t.Fatalf("got %d observations, want 4", len(obs))
	}
	if obs[0].BitEnd-obs[0].BitStart != 10 || obs[1].BitEnd-obs[1].BitStart != 8 {
		t.Fatalf("width clear failed: A=%d B=%d", obs[0].BitEnd-obs[0].BitStart, obs[1].BitEnd-obs[1].BitStart)
	}
	wantC := big.NewRat(3, 100)
	if obs[2].Value.Cmp(wantC) != 0 {
		t.Fatalf("C value=%s, want 3/100", obs[2].RationalString())
	}
	wantD := big.NewRat(4, 1)
	if obs[3].Value.Cmp(wantD) != 0 {
		t.Fatalf("D value=%s, want 4 (scale clear)", obs[3].RationalString())
	}
}

func TestOffsetsResetAtEachSubset(t *testing.T) {
	A := element(t, "A", 8, 0, "0")
	C := element(t, "C", 8, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
		{X: 1, Y: 3}: C,
	})
	rep := descriptor(t, 1, 3, 0)
	root := []de.Descriptor{
		rep,
		descriptor(t, 0, 31, 1),
		descriptor(t, 2, 1, 129),
		descriptor(t, 2, 2, 129),
		descriptor(t, 0, 1, 1),
		descriptor(t, 0, 1, 3),
	}
	tmpl := mustCompile(t, root, elements, nil)
	bits := stream(t,
		field(t, 8, 1),
		field(t, 9, 7),
		field(t, 9, 8),
		field(t, 8, 0),
		field(t, 8, 9),
	)
	obs := mustDecode(t, tmpl, bits, de.DecodeOptions{
		Subsets: 2, MaxObservations: -1, MaxSteps: 20, MaxDepth: 1,
	})
	if len(obs) != 3 {
		t.Fatalf("got %d observations, want 3", len(obs))
	}
	if obs[0].Subset != 1 || obs[1].Subset != 1 || obs[2].Subset != 2 {
		t.Fatalf("subsets = %d,%d,%d", obs[0].Subset, obs[1].Subset, obs[2].Subset)
	}
	if obs[1].BitEnd-obs[1].BitStart != 9 {
		t.Fatalf("first-subset C width=%d, want 9", obs[1].BitEnd-obs[1].BitStart)
	}
	if obs[2].BitStart != 34 || obs[2].BitEnd != 42 {
		t.Fatalf("second-subset C range=[%d,%d), want [34,42)", obs[2].BitStart, obs[2].BitEnd)
	}
	wantC1, _ := new(big.Rat).SetString("8/10")
	wantC2 := big.NewRat(9, 1)
	if obs[1].Value.Cmp(wantC1) != 0 {
		t.Fatalf("first C value=%s, want 8/10", obs[1].RationalString())
	}
	if obs[2].Value.Cmp(wantC2) != 0 {
		t.Fatalf("second C value=%s, want 9 (offsets must reset)", obs[2].RationalString())
	}
}

func TestZeroReplicationDoesNotExecuteBodyOrChangeState(t *testing.T) {
	A := element(t, "A", 8, 0, "0")
	B := element(t, "B", 8, 3, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
		{X: 1, Y: 2}: B,
	})
	rep := descriptor(t, 1, 3, 0)
	root := []de.Descriptor{
		rep,
		descriptor(t, 0, 31, 1),
		descriptor(t, 2, 1, 1), // effective A width would be invalid if executed.
		descriptor(t, 2, 2, 255),
		descriptor(t, 0, 1, 1),
		descriptor(t, 0, 1, 2),
	}
	compileOnly, err := de.Compile(root, elements, nil)
	if err != nil {
		t.Fatalf("compile must inspect but not reject inactive effective width: %v", err)
	}

	obs := mustDecode(t, compileOnly, stream(t, field(t, 8, 0), field(t, 8, 21)), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 3, MaxDepth: 0,
	})
	if len(obs) != 1 {
		t.Fatalf("got %d observations, want only B", len(obs))
	}
	if obs[0].Element.Y != 2 || obs[0].BitStart != 8 || obs[0].BitEnd != 16 {
		t.Fatalf("unexpected observation %#v", obs[0])
	}
	want, _ := new(big.Rat).SetString("21/1000")
	if obs[0].Value.Cmp(want) != 0 {
		t.Fatalf("B value=%s, want 21/1000", obs[0].RationalString())
	}

	failed, err := compileOnly.Decode(stream(t, field(t, 8, 1), field(t, 8, 21)), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 100, MaxDepth: 1,
	})
	if err == nil || !errors.Is(err, de.ErrEffectiveWidth) {
		t.Fatalf("non-zero body err=%v, want effective-width error", err)
	}
	if failed != nil {
		t.Fatalf("partial results after body error: %#v", failed)
	}
}

func TestSelectionDoesNotChangeDecodeOrBitPositions(t *testing.T) {
	A := element(t, "A", 8, 0, "0")
	B := element(t, "B", 8, 0, "0")
	C := element(t, "C", 8, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
		{X: 1, Y: 2}: B,
		{X: 1, Y: 3}: C,
	})
	root := []de.Descriptor{
		descriptor(t, 0, 1, 1),
		descriptor(t, 2, 1, 129),
		descriptor(t, 0, 1, 2),
		descriptor(t, 0, 1, 3),
	}
	tmpl := mustCompile(t, root, elements, nil)
	bits := stream(t, field(t, 8, 3), field(t, 9, 4), field(t, 9, 5))
	full := mustDecode(t, tmpl, bits, de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 10, MaxDepth: 0,
	})
	filtered := mustDecode(t, tmpl, bits, de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 10, MaxDepth: 0,
		Select: func(id de.ElementID) bool { return id.Y == 3 },
	})
	if len(full) != 3 || len(filtered) != 1 {
		t.Fatalf("full=%d filtered=%d observations", len(full), len(filtered))
	}
	if !reflect.DeepEqual(filtered[0], full[2]) {
		t.Fatalf("selected C differs from full decode:\n got %#v\nwant %#v", filtered[0], full[2])
	}
}

func TestTailPadding(t *testing.T) {
	tmpl := mustCompile(t, nil, nil, nil)
	for _, tc := range []struct {
		name string
		bits string
		ok   bool
	}{
		{"empty", "", true},
		{"7 zero bits", "0000000", true},
		{"7 bits with one", "0000001", false},
		{"8 zero bits", "00000000", false},
	} {
		if _, err := tmpl.Decode(stream(t, tc.bits), de.DecodeOptions{
			Subsets: 0, MaxObservations: -1, MaxSteps: 100, MaxDepth: -1,
		}); err != nil && tc.ok {
			t.Fatalf("%s: %v", tc.name, err)
		} else if err == nil && !tc.ok {
			t.Fatalf("%s: unexpectedly accepted", tc.name)
		} else if err != nil && !errors.Is(err, de.ErrInvalidPadding) {
			t.Fatalf("%s: err=%v, want padding error", tc.name, err)
		}
	}

	A := element(t, "A", 8, 0, "0")
	tmpl = mustCompile(t, []de.Descriptor{descriptor(t, 0, 1, 1)}, elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
	}), nil)
	if _, err := tmpl.Decode(stream(t, field(t, 8, 1), "000"), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 1, MaxDepth: 0,
	}); err != nil {
		t.Fatalf("3 zero tail bits after data: %v", err)
	}
	if _, err := tmpl.Decode(stream(t, field(t, 8, 1), "001"), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 1, MaxDepth: 0,
	}); err == nil || !errors.Is(err, de.ErrInvalidPadding) {
		t.Fatalf("nonzero tail after data err=%v", err)
	}
}

func TestPrecisionMissingAndScaleOffsets(t *testing.T) {
	hugeRef, _ := new(big.Int).SetString("-123456789012345678901234567890", 10)
	wide := element(t, "wide", 64, 3, hugeRef.String())
	smallScale := element(t, "scaled", 4, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: wide,
		{X: 1, Y: 2}: smallScale,
	})
	root := []de.Descriptor{
		descriptor(t, 0, 1, 1),
		descriptor(t, 2, 2, 129),
		descriptor(t, 0, 1, 2),
	}
	tmpl := mustCompile(t, root, elements, nil)
	u := ^uint64(0) - 1
	bits := stream(t, field(t, 64, u), field(t, 4, 11))
	obs := mustDecode(t, tmpl, bits, de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 10, MaxDepth: 0,
	})
	if len(obs) != 2 || obs[0].Missing || obs[1].Missing {
		t.Fatalf("unexpected observations: %#v", obs)
	}
	numerator := new(big.Int).SetUint64(u)
	numerator.Add(numerator, hugeRef)
	wantWide := new(big.Rat).SetFrac(numerator, new(big.Int).Exp(big.NewInt(10), big.NewInt(3), nil))
	if obs[0].Value.Cmp(wantWide) != 0 || obs[0].RationalString() != wantWide.RatString() {
		t.Fatalf("wide value=%s, want %s", obs[0].RationalString(), wantWide.RatString())
	}
	wantScaled := big.NewRat(11, 10)
	if obs[1].Value.Cmp(wantScaled) != 0 {
		t.Fatalf("scaled value=%s, want 11/10", obs[1].RationalString())
	}

	negativeScale := element(t, "negative-scale", 4, -2, "0")
	negativeTemplate := mustCompile(t,
		[]de.Descriptor{descriptor(t, 0, 1, 4)},
		elementTable(t, map[de.ElementKey]de.ElementDef{{X: 1, Y: 4}: negativeScale}),
		nil,
	)
	negativeObs := mustDecode(t, negativeTemplate, stream(t, field(t, 4, 3)), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 1, MaxDepth: 0,
	})
	if len(negativeObs) != 1 || negativeObs[0].Value.Cmp(big.NewRat(300, 1)) != 0 {
		t.Fatalf("negative scale value=%s, want 300", negativeObs[0].RationalString())
	}

	// A 3-bit effective width makes 111 missing.
	missingRoot := []de.Descriptor{
		descriptor(t, 2, 1, 123), // width offset -5, base 8 -> 3
		descriptor(t, 0, 1, 3),
	}
	missingElements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 3}: element(t, "missing", 8, 0, "0"),
	})
	missingTemplate := mustCompile(t, missingRoot, missingElements, nil)
	missing := mustDecode(t, missingTemplate, stream(t, "111"), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 10, MaxDepth: 0,
	})
	if len(missing) != 1 || !missing[0].Missing || missing[0].Value != nil || missing[0].Raw != 7 {
		t.Fatalf("missing observation = %#v", missing)
	}
}

func TestFactorAllOnesAndAtomicLimits(t *testing.T) {
	A := element(t, "A", 8, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
	})
	root := []de.Descriptor{
		descriptor(t, 1, 1, 0),
		descriptor(t, 0, 31, 1),
		descriptor(t, 0, 1, 1),
	}
	tmpl := mustCompile(t, root, elements, nil)
	failed, err := tmpl.Decode(stream(t, field(t, 8, 255), field(t, 8, 1)), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 10, MaxDepth: 1,
	})
	if err == nil || !errors.Is(err, de.ErrInvalidFactor) || failed != nil {
		t.Fatalf("all-ones factor err=%v result=%#v", err, failed)
	}

	failed, err = tmpl.Decode(stream(t, field(t, 8, 0)), de.DecodeOptions{
		Subsets: 1, MaxObservations: 1, MaxSteps: 10, MaxDepth: 1,
	})
	// Count zero needs only F1 and factor steps, so this must succeed with no
	// observations and no body output.
	if err != nil || len(failed) != 0 {
		t.Fatalf("zero factor err=%v obs=%#v", err, failed)
	}

	failed, err = tmpl.Decode(stream(t, field(t, 8, 1), field(t, 8, 7)), de.DecodeOptions{
		Subsets: 1, MaxObservations: 0, MaxSteps: 10, MaxDepth: 1,
	})
	if err == nil || !errors.Is(err, de.ErrObservationLimit) || failed != nil {
		t.Fatalf("observation limit err=%v result=%#v", err, failed)
	}

	// The factor uses its fixed 8/16-bit form regardless of the current width
	// offset; only the following A element is widened by three bits.
	factorRoot := []de.Descriptor{
		descriptor(t, 2, 1, 131),
		descriptor(t, 1, 1, 0),
		descriptor(t, 0, 31, 1),
		descriptor(t, 0, 1, 1),
	}
	factorTemplate := mustCompile(t, factorRoot, elements, nil)
	obs := mustDecode(t, factorTemplate, stream(t, field(t, 8, 1), field(t, 11, 5)), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 10, MaxDepth: 1,
	})
	if len(obs) != 1 || obs[0].BitStart != 8 || obs[0].BitEnd != 19 {
		t.Fatalf("factor must not be affected by width operator: %#v", obs)
	}
}

func TestUnselectedElementStillValidatesWidth(t *testing.T) {
	A := element(t, "A", 8, 0, "0")
	B := element(t, "B", 8, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: A,
		{X: 1, Y: 2}: B,
	})
	root := []de.Descriptor{
		descriptor(t, 0, 1, 1),
		descriptor(t, 2, 1, 1),
		descriptor(t, 0, 1, 2),
	}
	tmpl := mustCompile(t, root, elements, nil)
	failed, err := tmpl.Decode(stream(t, field(t, 8, 1)), de.DecodeOptions{
		Subsets: 1, MaxObservations: -1, MaxSteps: 10, MaxDepth: 0,
		Select: func(id de.ElementID) bool { return id.Y == 1 },
	})
	if err == nil || !errors.Is(err, de.ErrEffectiveWidth) || failed != nil {
		t.Fatalf("unselected invalid B err=%v result=%#v", err, failed)
	}
}

func TestCompileRejectsReachableInvalidBranches(t *testing.T) {
	known := element(t, "known", 8, 0, "0")
	elements := elementTable(t, map[de.ElementKey]de.ElementDef{
		{X: 1, Y: 1}: known,
	})

	tests := []struct {
		name string
		root []de.Descriptor
		seqs de.SequenceTable
		want error
	}{
		{
			name: "unknown element in zero body",
			root: []de.Descriptor{
				descriptor(t, 1, 1, 0),
				descriptor(t, 0, 31, 1),
				descriptor(t, 0, 9, 9),
			},
			want: de.ErrUnknownElement,
		},
		{
			name: "unknown sequence in zero body",
			root: []de.Descriptor{
				descriptor(t, 1, 1, 0),
				descriptor(t, 0, 31, 1),
				descriptor(t, 3, 9, 9),
			},
			want: de.ErrUnknownSequence,
		},
		{
			name: "sequence cycle through zero replication",
			root: []de.Descriptor{descriptor(t, 3, 1, 1)},
			seqs: de.SequenceTable{
				{X: 1, Y: 1}: {
					descriptor(t, 1, 1, 0),
					descriptor(t, 0, 31, 1),
					descriptor(t, 3, 1, 1),
				},
			},
			want: de.ErrSequenceCycle,
		},
		{
			name: "outer boundary cuts nested factor and body",
			root: []de.Descriptor{
				descriptor(t, 1, 2, 0),
				descriptor(t, 0, 31, 1),
				descriptor(t, 1, 1, 0),
				descriptor(t, 0, 31, 2),
				descriptor(t, 0, 1, 1),
			},
			want: de.ErrReplicationBoundary,
		},
		{
			name: "fixed replication body overruns root",
			root: []de.Descriptor{
				descriptor(t, 1, 3, 2),
				descriptor(t, 0, 1, 1),
			},
			want: de.ErrReplicationBoundary,
		},
		{
			name: "dedicated factor outside replication",
			root: []de.Descriptor{descriptor(t, 0, 31, 1)},
			want: de.ErrReservedFactor,
		},
		{
			name: "delayed replication without dedicated factor",
			root: []de.Descriptor{
				descriptor(t, 1, 1, 0),
				descriptor(t, 0, 1, 1),
			},
			want: de.ErrInvalidFactor,
		},
		{
			name: "replication X zero",
			root: []de.Descriptor{descriptor(t, 1, 0, 2)},
			want: de.ErrInvalidReplication,
		},
		{
			name: "operator X three",
			root: []de.Descriptor{descriptor(t, 2, 3, 1)},
			want: de.ErrInvalidOperator,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tmpl, err := de.Compile(tc.root, elements, tc.seqs)
			if err == nil || !errors.Is(err, tc.want) {
				t.Fatalf("err=%v template=%v, want errors.Is(%v)", err, tmpl, tc.want)
			}
			if tmpl != nil {
				t.Fatalf("compile published partial template")
			}
		})
	}
}

func TestInvalidElementDefinitionFoundInUnexecutedBranch(t *testing.T) {
	ref := big.NewInt(0)
	bad := de.ElementDef{Name: "bad", BitWidth: 0, Scale: 0, Reference: ref}
	elements := de.ElementTable{{X: 1, Y: 1}: bad}
	root := []de.Descriptor{
		descriptor(t, 1, 1, 0),
		descriptor(t, 0, 31, 1),
		descriptor(t, 0, 1, 1),
	}
	tmpl, err := de.Compile(root, elements, nil)
	if err == nil || !errors.Is(err, de.ErrInvalidElement) || tmpl != nil {
		t.Fatalf("err=%v template=%v", err, tmpl)
	}
}

func TestInvalidOptions(t *testing.T) {
	tmpl := mustCompile(t, nil, nil, nil)
	for _, opts := range []de.DecodeOptions{
		{Subsets: -1, MaxObservations: -1, MaxSteps: 1, MaxDepth: 0},
		{Subsets: 1, MaxObservations: -2, MaxSteps: 1, MaxDepth: 0},
		{Subsets: 1, MaxObservations: -1, MaxSteps: -2, MaxDepth: 0},
		{Subsets: 1, MaxObservations: -1, MaxSteps: 1, MaxDepth: -2},
	} {
		if _, err := tmpl.Decode(de.BitString{}, opts); err == nil || !errors.Is(err, de.ErrInvalidOptions) {
			t.Fatalf("opts=%+v err=%v, want invalid options", opts, err)
		}
	}
}

func ExampleTemplate_Decode() {
	// An 8-bit temperature element: value = raw * 10^-1.
	ref := big.NewInt(0)
	temperature, _ := de.NewElementDef("air-temperature", 8, 1, ref)
	elements := de.ElementTable{{X: 1, Y: 1}: temperature}
	template, _ := de.Compile([]de.Descriptor{{F: 0, X: 1, Y: 1}}, elements, nil)

	bits, _ := de.NewBitString("00010100") // raw 20
	observations, err := template.Decode(bits, de.DecodeOptions{
		Subsets:         1,
		MaxObservations: 1,
		MaxSteps:        4,
		MaxDepth:        0,
	})
	if err != nil {
		panic(err)
	}
	for _, obs := range observations {
		fmt.Printf("subset=%d element=%02d-%03d value=%s bits=[%d,%d)\n",
			obs.Subset, obs.Element.X, obs.Element.Y, obs.RationalString(),
			obs.BitStart, obs.BitEnd)
	}
	// Output:
	// subset=1 element=01-001 value=2 bits=[0,8)
}
