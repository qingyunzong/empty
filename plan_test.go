package imgdiff

import (
	"math/rand"
	"strings"
	"testing"
)

const testBlock = 4

// specImage builds an image from a per-block spec: '-' is a hole, any other
// byte is a data block filled with that byte. shared marks block indices
// backed by the parent snapshot.
func specImage(spec string, shared map[int]bool) *Image {
	img := &Image{Size: uint64(len(spec)) * testBlock}
	for i, c := range spec {
		e := Extent{Start: uint64(i) * testBlock, Len: testBlock}
		if c == '-' {
			e.Kind = Hole
		} else {
			e.Kind = Data
			e.Data = []byte{byte(c), byte(c), byte(c), byte(c)}
			e.Shared = shared[i]
		}
		img.Extents = append(img.Extents, e)
	}
	return img
}

func mustPlan(t *testing.T, old, newImg *Image) *Plan {
	t.Helper()
	p, err := BuildPlan(old, newImg, testBlock)
	if err != nil {
		t.Fatalf("BuildPlan: %v", err)
	}
	if err := VerifyPlan(old, newImg, p); err != nil {
		t.Fatalf("VerifyPlan: %v\nsteps: %v", err, p.Steps)
	}
	return p
}

func opCounts(p *Plan) map[Op]int {
	out := map[Op]int{}
	for _, s := range p.Steps {
		out[s.Op]++
	}
	return out
}

func TestPlanNoop(t *testing.T) {
	old := specImage("AB-C", nil)
	p := mustPlan(t, old, specImage("AB-C", nil))
	if len(p.Steps) != 0 {
		t.Fatalf("want empty plan, got %v", p.Steps)
	}
}

func TestPlanSimpleMove(t *testing.T) {
	// Content of block 0 moves to block 1; block 0 becomes a hole.
	old := specImage("A-", nil)
	p := mustPlan(t, old, specImage("-A", nil))
	c := opCounts(p)
	if c[OpMove] != 1 || c[OpPunch] != 1 || c[OpStageSave] != 0 {
		t.Fatalf("want one move and one punch, got %v (%v)", c, p.Steps)
	}
}

func TestPlanSwapUsesStaging(t *testing.T) {
	// Swapping two blocks is a 2-cycle: impossible without staging.
	old := specImage("AB", nil)
	p := mustPlan(t, old, specImage("BA", nil))
	c := opCounts(p)
	if c[OpStageSave] != 1 || c[OpStageLoad] != 1 || c[OpMove] != 1 {
		t.Fatalf("want cycle broken with one staging block, got %v (%v)", c, p.Steps)
	}
}

func TestPlanLongerCycle(t *testing.T) {
	old := specImage("ABCD", nil)
	p := mustPlan(t, old, specImage("DABC", nil)) // rotate: 4-cycle
	c := opCounts(p)
	if c[OpStageSave] != 1 || c[OpStageLoad] != 1 || c[OpMove] != 3 {
		t.Fatalf("want 3 moves + staging pair, got %v (%v)", c, p.Steps)
	}
}

func TestPlanTwoIndependentCycles(t *testing.T) {
	old := specImage("ABCD", nil)
	p := mustPlan(t, old, specImage("BADC", nil)) // two 2-cycles
	c := opCounts(p)
	if c[OpStageSave] != 2 || c[OpStageLoad] != 2 || c[OpMove] != 2 {
		t.Fatalf("want each cycle broken separately, got %v (%v)", c, p.Steps)
	}
}

func TestPlanChainNeedsNoStaging(t *testing.T) {
	old := specImage("AB-", nil)
	p := mustPlan(t, old, specImage("-AB", nil)) // shift right into a hole
	c := opCounts(p)
	if c[OpStageSave] != 0 || c[OpMove] != 2 || c[OpPunch] != 1 {
		t.Fatalf("want pure chain, got %v (%v)", c, p.Steps)
	}
}

func TestPlanWriteNewData(t *testing.T) {
	old := specImage("A-", nil)
	p := mustPlan(t, old, specImage("AZ", nil)) // Z is not in old
	c := opCounts(p)
	if c[OpWrite] != 1 || c[OpMove] != 0 {
		t.Fatalf("want literal write, got %v (%v)", c, p.Steps)
	}
}

func TestPlanZeroBlockVsHole(t *testing.T) {
	// Zero data block and hole are content-equal but layout-different.
	zero := specImage(string(rune(0))+"-", nil) // block 0: zero-filled data
	holeFirst := specImage("-"+string(rune(0)), nil)
	p := mustPlan(t, zero, holeFirst)
	c := opCounts(p)
	if c[OpPunch] != 1 || c[OpMove]+c[OpWrite] != 1 {
		t.Fatalf("want punch + zero relocation, got %v (%v)", c, p.Steps)
	}
	// Content is identical; only layout differs.
	cd, _ := ContentDiff(zero, holeFirst)
	ld, _ := LayoutDiff(zero, holeFirst)
	if len(cd) != 0 || len(ld) != 1 || ld[0] != (Interval{0, 8}) {
		t.Fatalf("content %v, layout %v", cd, ld)
	}
}

func TestPlanSharedDestinationUnshared(t *testing.T) {
	shared := map[int]bool{1: true}
	old := specImage("AB", shared)
	newImg := specImage("BA", nil)
	p := mustPlan(t, old, newImg)
	// Every write to a shared block must be preceded by its unshare.
	unshared := map[int]bool{}
	for _, s := range p.Steps {
		switch s.Op {
		case OpUnshare:
			unshared[s.Dst] = true
		case OpMove, OpWrite, OpStageLoad:
			if shared[s.Dst] && !unshared[s.Dst] {
				t.Fatalf("step %v writes shared block %d before unshare\n%v", s, s.Dst, p.Steps)
			}
		}
	}
	if opCounts(p)[OpUnshare] == 0 {
		t.Fatalf("want unshare steps in %v", p.Steps)
	}
}

func TestPlanSharedSourceReadOnly(t *testing.T) {
	// Shared block is a move source; it must never be written.
	shared := map[int]bool{0: true}
	old := specImage("A-", shared)
	p := mustPlan(t, old, specImage("-A", nil))
	for _, s := range p.Steps {
		if (s.Op == OpMove || s.Op == OpWrite || s.Op == OpStageLoad) && s.Dst == 0 {
			t.Fatalf("shared source block written: %v", p.Steps)
		}
		if s.Op == OpUnshare && s.Dst == 0 {
			t.Fatalf("source-only shared block unshared needlessly: %v", p.Steps)
		}
	}
}

func TestPlanRejectsBadInput(t *testing.T) {
	a := specImage("AB", nil)
	b := specImage("ABC", nil)
	if _, err := BuildPlan(a, b, testBlock); err == nil {
		t.Fatal("size mismatch accepted")
	}
	if _, err := BuildPlan(a, a, 0); err == nil {
		t.Fatal("zero block size accepted")
	}
	if _, err := BuildPlan(a, a, 3); err == nil {
		t.Fatal("non-multiple block size accepted")
	}
	unaligned := &Image{Size: 8, Extents: []Extent{dataExt(1, []byte{1, 1, 1, 1})}}
	if _, err := BuildPlan(unaligned, unaligned, testBlock); err == nil {
		t.Fatal("unaligned extent accepted")
	}
}

// --- independent executor rejection of bad plans ---

func TestExecRejectsOverwriteOfUnsavedSource(t *testing.T) {
	old := specImage("AB", nil)
	// Bad plan: overwrite block 0 (content A) before moving A out.
	bad := &Plan{BlockSize: testBlock, Steps: []Step{
		{Op: OpMove, Src: 1, Dst: 0, SrcHash: HashContent([]byte("BBBB"))},
		{Op: OpMove, Src: 0, Dst: 1, SrcHash: HashContent([]byte("AAAA"))},
	}}
	err := VerifyPlan(old, specImage("BA", nil), bad)
	if err == nil || !strings.Contains(err.Error(), "unsaved source") {
		t.Fatalf("want unsaved-source error, got %v", err)
	}
}

func TestExecRejectsWriteToSharedBlock(t *testing.T) {
	old := specImage("A", map[int]bool{0: true})
	bad := &Plan{BlockSize: testBlock, Steps: []Step{
		{Op: OpWrite, Src: -1, Dst: 0, Data: []byte("ZZZZ")},
	}}
	if err := VerifyPlan(old, specImage("Z", nil), bad); err == nil {
		t.Fatal("write to shared block accepted")
	}
}

func TestExecRejectsDoubleStaging(t *testing.T) {
	old := specImage("AB", nil)
	bad := &Plan{BlockSize: testBlock, Steps: []Step{
		{Op: OpStageSave, Src: 0, Dst: -1, SrcHash: HashContent([]byte("AAAA"))},
		{Op: OpStageSave, Src: 1, Dst: -1, SrcHash: HashContent([]byte("BBBB"))},
	}}
	if err := VerifyPlan(old, specImage("AB", nil), bad); err == nil {
		t.Fatal("second stage-save accepted; staging must hold at most one block")
	}
}

func TestExecRejectsStageLoadFromEmpty(t *testing.T) {
	old := specImage("A", nil)
	bad := &Plan{BlockSize: testBlock, Steps: []Step{
		{Op: OpStageLoad, Src: -1, Dst: 0, SrcHash: HashContent([]byte("AAAA"))},
	}}
	// Block 0 already holds AAAA, so the idempotent no-op path accepts it;
	// use a hash that does not match to force the error.
	bad.Steps[0].SrcHash = HashContent([]byte("QQQQ"))
	if err := VerifyPlan(old, specImage("A", nil), bad); err == nil {
		t.Fatal("stage-load from empty staging accepted")
	}
}

func TestExecDetectsParentCorruption(t *testing.T) {
	// A plan that (wrongly) unshares then leaves parent intact is fine;
	// here we check the verifier catches a mismatching final image.
	old := specImage("AB", nil)
	if err := VerifyPlan(old, specImage("BA", nil), &Plan{BlockSize: testBlock}); err == nil {
		t.Fatal("empty plan verified against different image")
	}
}

// --- crash / resume ---

// runCrashed executes the first k steps, simulates an interruption, then
// resumes and verifies. mode "partial" leaves debris from the interrupted
// step; mode "reexec" loses the journal entry for the last completed step.
func runCrashed(t *testing.T, old, newImg *Image, p *Plan, k int, mode string) error {
	t.Helper()
	m, err := NewMachine(old, p.BlockSize)
	if err != nil {
		t.Fatal(err)
	}
	before := m.ParentSnapshot()
	for i := 0; i < k; i++ {
		if err := m.Step(p); err != nil {
			t.Fatalf("step %d: %v", i, err)
		}
	}
	switch mode {
	case "partial":
		if k < len(p.Steps) {
			m.CorruptTarget(p.Steps[k])
		}
	case "reexec":
		if k > 0 {
			m.Next--
		}
	}
	if err := m.Run(p); err != nil {
		return err
	}
	return m.Verify(newImg, before)
}

func TestPlanCrashResumeTargeted(t *testing.T) {
	old := specImage("ABCD", map[int]bool{2: true})
	newImg := specImage("DABC", nil)
	p := mustPlan(t, old, newImg)
	for k := 0; k <= len(p.Steps); k++ {
		for _, mode := range []string{"partial", "reexec"} {
			if err := runCrashed(t, old, newImg, p, k, mode); err != nil {
				t.Fatalf("crash at step %d (%s): %v\nsteps: %v", k, mode, err, p.Steps)
			}
		}
	}
}

// --- randomized property test ---

// randBlocks picks n random block contents from a small alphabet so that
// duplicates, zeros and moves all occur.
func randBlocks(r *rand.Rand, n int) [][]byte {
	alphabet := [][]byte{
		[]byte{0, 0, 0, 0},
		[]byte{1, 1, 1, 1},
		[]byte{2, 2, 2, 2},
		[]byte{3, 3, 3, 3},
		[]byte{4, 4, 4, 4},
		[]byte{5, 5, 5, 5},
	}
	out := make([][]byte, n)
	for i := range out {
		out[i] = alphabet[r.Intn(len(alphabet))]
	}
	return out
}

func imageFromBlocks(blocks [][]byte, holes []bool, shared map[int]bool) *Image {
	img := &Image{Size: uint64(len(blocks)) * testBlock}
	for i, b := range blocks {
		e := Extent{Start: uint64(i) * testBlock, Len: testBlock}
		if holes[i] {
			e.Kind = Hole
		} else {
			e.Kind = Data
			e.Data = append([]byte(nil), b...)
			e.Shared = shared[i]
		}
		img.Extents = append(img.Extents, e)
	}
	return img
}

func TestPlanRandom(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	for trial := 0; trial < 500; trial++ {
		n := 1 + r.Intn(9)
		oldBlocks := randBlocks(r, n)
		oldHoles := make([]bool, n)
		for i := range oldHoles {
			oldHoles[i] = r.Intn(4) == 0
		}
		shared := map[int]bool{}
		for i := 0; i < n; i++ {
			if !oldHoles[i] && r.Intn(3) == 0 {
				shared[i] = true
			}
		}
		// New image: shuffle of old blocks plus holes and occasional novel
		// content, so moves, cycles, writes and punches all appear.
		newBlocks := randBlocks(r, n)
		newHoles := make([]bool, n)
		for i := range newHoles {
			newHoles[i] = r.Intn(4) == 0
		}
		if r.Intn(2) == 0 {
			perm := r.Perm(n)
			for i := 0; i < n; i++ {
				newBlocks[i] = oldBlocks[perm[i]]
				newHoles[i] = oldHoles[perm[i]]
			}
		}
		oldImg := imageFromBlocks(oldBlocks, oldHoles, shared)
		newImg := imageFromBlocks(newBlocks, newHoles, nil)

		p, err := BuildPlan(oldImg, newImg, testBlock)
		if err != nil {
			t.Fatalf("trial %d: BuildPlan: %v", trial, err)
		}
		if err := VerifyPlan(oldImg, newImg, p); err != nil {
			t.Fatalf("trial %d: VerifyPlan: %v\nsteps: %v", trial, err, p.Steps)
		}
		// Crash and resume at every step boundary, both interruption modes.
		for k := 0; k <= len(p.Steps); k++ {
			for _, mode := range []string{"partial", "reexec"} {
				if err := runCrashed(t, oldImg, newImg, p, k, mode); err != nil {
					t.Fatalf("trial %d: crash at step %d/%d (%s): %v\nsteps: %v",
						trial, k, len(p.Steps), mode, err, p.Steps)
				}
			}
		}
	}
}
