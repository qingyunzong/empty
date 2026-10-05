package imgdiff

import (
	"crypto/sha256"
	"encoding/hex"
	"math/rand"
	"strings"
	"testing"
)

// diskManifest builds a manifest from a disk, one extent per block.
func diskManifest(d *Disk) *Manifest {
	m := &Manifest{Size: uint64(d.Blocks() * d.BlockSize)}
	for i := 0; i < d.Blocks(); i++ {
		s := Extent{Start: uint64(i * d.BlockSize), End: uint64((i + 1) * d.BlockSize)}
		if d.Alloc[i] {
			content := d.ReadBlock(i)
			sum := sha256.Sum256(content)
			s.Data = true
			s.Digest = hex.EncodeToString(sum[:])
			s.Zero = isZero(content)
		}
		m.Extents = append(m.Extents, s)
	}
	return m
}

func isZero(b []byte) bool {
	for _, x := range b {
		if x != 0 {
			return false
		}
	}
	return true
}

// digestSource maps every allocated block's digest to its content.
func digestSource(d *Disk) map[string][]byte {
	out := map[string][]byte{}
	for i := 0; i < d.Blocks(); i++ {
		if !d.Alloc[i] {
			continue
		}
		content := d.ReadBlock(i)
		if isZero(content) {
			continue
		}
		sum := sha256.Sum256(content)
		out[hex.EncodeToString(sum[:])] = content
	}
	return out
}

// randDisk builds a random disk: data blocks (some zero-filled) and holes.
func randDisk(r *rand.Rand, nblocks, blockSize int) *Disk {
	d := NewDisk(nblocks, blockSize)
	for i := 0; i < nblocks; i++ {
		switch r.Intn(4) {
		case 0, 1, 2:
			content := make([]byte, blockSize)
			for j := range content {
				content[j] = byte(r.Intn(3))
			}
			d.WriteBlock(i, content)
		default: // hole
		}
	}
	return d
}

// mutateDisk derives a new disk from an old one: blocks are kept,
// moved (creating overlapping copies and cycles), randomized, zeroed
// or punched.
func mutateDisk(r *rand.Rand, old *Disk) *Disk {
	n := old.Blocks()
	d := NewDisk(n, old.BlockSize)
	for i := 0; i < n; i++ {
		switch r.Intn(6) {
		case 0, 1: // keep
			if old.Alloc[i] {
				d.WriteBlock(i, old.ReadBlock(i))
			}
		case 2: // move another old block here
			j := r.Intn(n)
			if old.Alloc[j] {
				d.WriteBlock(i, old.ReadBlock(j))
			}
		case 3: // brand new content
			content := make([]byte, old.BlockSize)
			for k := range content {
				content[k] = byte(r.Intn(256))
			}
			d.WriteBlock(i, content)
		case 4: // zero block
			d.WriteBlock(i, make([]byte, old.BlockSize))
		default: // hole
		}
	}
	return d
}

func cloneState(st *State) *State {
	return &State{
		Disk:         st.Disk.Clone(),
		Scratch:      append([]byte(nil), st.Scratch...),
		ScratchValid: st.ScratchValid,
		Next:         st.Next,
	}
}

func checkMigration(t *testing.T, old, new *Disk) {
	t.Helper()
	oldM := diskManifest(old)
	newM := diskManifest(new)
	block := uint64(old.BlockSize)
	plan, err := MakePlan(oldM, newM, block)
	if err != nil {
		t.Fatalf("MakePlan: %v", err)
	}
	if err := VerifyPlan(oldM, newM, plan); err != nil {
		t.Fatalf("VerifyPlan: %v", err)
	}
	source := digestSource(new)

	// Straight execution.
	st := NewState(old.Clone())
	ex := &Executor{St: st, Plan: plan, Source: source}
	if err := ex.Run(); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !st.Disk.Equal(new) {
		t.Fatalf("final disk does not match new image")
	}

	// Crash after every step, then resume from the journal.
	for k := 0; k <= len(plan.Steps); k++ {
		st := NewState(old.Clone())
		ex := &Executor{St: st, Plan: plan, Source: source}
		for i := 0; i < k; i++ {
			if err := ex.Step(); err != nil {
				t.Fatalf("step %d: %v", i, err)
			}
		}
		resumed := &Executor{St: cloneState(st), Plan: plan, Source: source}
		if err := resumed.Run(); err != nil {
			t.Fatalf("resume after %d steps: %v", k, err)
		}
		if !resumed.St.Disk.Equal(new) {
			t.Fatalf("resume after %d steps: final disk mismatch", k)
		}
	}

	// Crash after applying each step but before journaling it: the
	// step is re-executed on resume and must be idempotent.
	for k := 0; k < len(plan.Steps); k++ {
		st := NewState(old.Clone())
		ex := &Executor{St: st, Plan: plan, Source: source}
		for i := 0; i <= k; i++ {
			if err := ex.Step(); err != nil {
				t.Fatalf("step %d: %v", i, err)
			}
		}
		st.Next-- // journal lost: step k will be redone
		resumed := &Executor{St: cloneState(st), Plan: plan, Source: source}
		if err := resumed.Run(); err != nil {
			t.Fatalf("redo step %d: %v", k, err)
		}
		if !resumed.St.Disk.Equal(new) {
			t.Fatalf("redo step %d: final disk mismatch", k)
		}
	}
}

func TestPlanRandomMigrations(t *testing.T) {
	r := rand.New(rand.NewSource(3))
	for iter := 0; iter < 150; iter++ {
		nblocks := 1 + r.Intn(9)
		blockSize := 1 + r.Intn(8)
		old := randDisk(r, nblocks, blockSize)
		new := mutateDisk(r, old)
		checkMigration(t, old, new)
	}
}

func TestPlanRotationCycle(t *testing.T) {
	const bs = 4
	old := NewDisk(3, bs)
	copy(old.Data[0:bs], []byte("AAAA"))
	copy(old.Data[bs:2*bs], []byte("BBBB"))
	copy(old.Data[2*bs:3*bs], []byte("CCCC"))
	old.Alloc[0], old.Alloc[1], old.Alloc[2] = true, true, true
	// New image rotates the blocks: [C, A, B].
	new := NewDisk(3, bs)
	new.WriteBlock(0, []byte("CCCC"))
	new.WriteBlock(1, []byte("AAAA"))
	new.WriteBlock(2, []byte("BBBB"))

	oldM, newM := diskManifest(old), diskManifest(new)
	plan, err := MakePlan(oldM, newM, bs)
	if err != nil {
		t.Fatal(err)
	}
	var saves, restores int
	for _, op := range plan.Steps {
		switch op.Op {
		case "save":
			saves++
		case "restore":
			restores++
		}
	}
	if saves != 1 || restores != 1 {
		t.Fatalf("rotation needs exactly one save and one restore, got %v", plan.Steps)
	}
	if err := VerifyPlan(oldM, newM, plan); err != nil {
		t.Fatal(err)
	}
	checkMigration(t, old, new)
}

func TestPlanSwapCycle(t *testing.T) {
	const bs = 2
	old := NewDisk(2, bs)
	old.WriteBlock(0, []byte("AA"))
	old.WriteBlock(1, []byte("BB"))
	new := NewDisk(2, bs)
	new.WriteBlock(0, []byte("BB"))
	new.WriteBlock(1, []byte("AA"))
	checkMigration(t, old, new)
}

func TestPlanOverlappingShift(t *testing.T) {
	// Every block moves one position to the right; destinations
	// overlap sources that are still needed.
	const bs = 2
	old := NewDisk(5, bs)
	for i := 0; i < 4; i++ {
		old.WriteBlock(i, []byte{byte('A' + i), byte('a' + i)})
	}
	new := NewDisk(5, bs)
	for i := 0; i < 4; i++ {
		new.WriteBlock(i+1, old.ReadBlock(i))
	}
	checkMigration(t, old, new)
}

func TestPlanZeroAndHoleLayout(t *testing.T) {
	// Content barely changes, but holes become zero blocks and vice
	// versa: layout-only migration.
	const bs = 3
	old := NewDisk(4, bs)
	old.WriteBlock(1, []byte{1, 2, 3})
	new := NewDisk(4, bs)
	new.WriteBlock(0, make([]byte, bs)) // hole -> zero block
	new.WriteBlock(1, []byte{1, 2, 3})  // unchanged
	new.WriteBlock(2, nil)              // hole -> zero block (nil = zeros)
	checkMigration(t, old, new)
}

func TestVerifyPlanRejectsUnsavedOverwrite(t *testing.T) {
	const bs = 2
	old := NewDisk(2, bs)
	old.WriteBlock(0, []byte("AA"))
	old.WriteBlock(1, []byte("BB"))
	new := NewDisk(2, bs)
	new.WriteBlock(0, []byte("BB"))
	new.WriteBlock(1, []byte("AA"))
	oldM, newM := diskManifest(old), diskManifest(new)

	// Swapping without saving to scratch first destroys block 1
	// while it is still needed as a source.
	bad := &Plan{Block: bs, Steps: []Op{
		{Op: "copy", Src: 1, Dst: 0},
		{Op: "copy", Src: 0, Dst: 1},
	}}
	err := VerifyPlan(oldM, newM, bad)
	if err == nil || !strings.Contains(err.Error(), "still read") {
		t.Fatalf("expected overwrite-of-unsaved-source error, got %v", err)
	}

	// Two saves without an intervening restore need two scratch blocks.
	bad2 := &Plan{Block: bs, Steps: []Op{
		{Op: "save", Block: 0},
		{Op: "save", Block: 1},
		{Op: "restore", Dst: 0},
		{Op: "restore", Dst: 1},
	}}
	err = VerifyPlan(oldM, newM, bad2)
	if err == nil || !strings.Contains(err.Error(), "second scratch block") {
		t.Fatalf("expected second-scratch-block error, got %v", err)
	}

	// A plan that never reaches the new layout.
	bad3 := &Plan{Block: bs, Steps: []Op{
		{Op: "save", Block: 0},
		{Op: "restore", Dst: 1},
	}}
	err = VerifyPlan(oldM, newM, bad3)
	if err == nil || !strings.Contains(err.Error(), "new image wants") {
		t.Fatalf("expected final-state mismatch, got %v", err)
	}
}

func TestPlanRejectsMisaligned(t *testing.T) {
	m := &Manifest{Size: 10, Extents: []Extent{
		{Start: 0, End: 5, Data: true, Digest: "x"},
	}}
	if _, err := MakePlan(m, m, 4); err == nil {
		t.Fatal("expected alignment error")
	}
	m2 := &Manifest{Size: 8}
	if _, err := MakePlan(m, m2, 4); err == nil {
		t.Fatal("expected size mismatch error")
	}
}
