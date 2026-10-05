package textstream

import (
	"errors"
	"math/rand"
	"slices"
	"testing"
	"unicode/utf8"
)

func mustApply(t *testing.T, d *Document, base int, edits ...Edit) (*Version, Diff) {
	t.Helper()
	v, diff, err := d.ApplyEdits(base, edits...)
	if err != nil {
		t.Fatalf("ApplyEdits: %v", err)
	}
	return v, diff
}

func TestBasicReplaceNetAndMigration(t *testing.T) {
	d := NewDocument([]byte("hello 世界")) // 6 ASCII bytes + 世[6,9) + 界[9,12)
	v1, diff := mustApply(t, d, 0, Edit{Start: 6, End: 12, Text: []byte("世界！")})

	if got := string(v1.Runes()); got != "hello 世界！" {
		t.Fatalf("new content = %q", got)
	}
	if diff.NetRunes != 1 {
		t.Fatalf("NetRunes = %d, want 1", diff.NetRunes)
	}
	if diff.OldRunes != [2]int{6, 8} || diff.NewRunes != [2]int{6, 9} {
		t.Fatalf("runes ranges = %v/%v", diff.OldRunes, diff.NewRunes)
	}
	if diff.OldBytes != [2]int{6, 12} || diff.NewBytes != [2]int{6, 15} {
		t.Fatalf("byte ranges = %v/%v", diff.OldBytes, diff.NewBytes)
	}
	for i, want := range []int{0, 1, 2, 3, 4, 5, -1, -1} {
		if got := diff.Migrate(i); got != want {
			t.Fatalf("Migrate(%d) = %d, want %d", i, got, want)
		}
	}
}

func TestDeleteAndTailMigration(t *testing.T) {
	d := NewDocument([]byte("ab水cd")) // 水 occupies bytes [2,5)
	v1, diff := mustApply(t, d, 0, Edit{Start: 2, End: 5})

	if got := string(v1.Runes()); got != "abcd" {
		t.Fatalf("new content = %q", got)
	}
	if diff.NetRunes != -1 {
		t.Fatalf("NetRunes = %d, want -1", diff.NetRunes)
	}
	for old, want := range map[int]int{0: 0, 1: 1, 2: -1, 3: 2, 4: 3} {
		if got := diff.Migrate(old); got != want {
			t.Fatalf("Migrate(%d) = %d, want %d", old, got, want)
		}
	}
	// Tail code points keep their identity, shifted by the byte delta.
	maps := v1.Mappings()
	if maps[2] != (Mapping{Start: 2, End: 3}) || maps[3] != (Mapping{Start: 3, End: 4}) {
		t.Fatalf("tail mappings = %+v", maps[2:])
	}
}

func TestOverlapRejected(t *testing.T) {
	d := NewDocument([]byte("abcdef"))
	_, _, err := d.ApplyEdits(0, Edit{Start: 1, End: 4, Text: []byte("X")}, Edit{Start: 3, End: 5, Text: []byte("Y")})
	if !errors.Is(err, ErrOverlap) {
		t.Fatalf("err = %v, want ErrOverlap", err)
	}
	if d.Versions() != 1 {
		t.Fatalf("rejected batch still committed: %d versions", d.Versions())
	}
	// Out-of-range edits are rejected too.
	if _, _, err := d.ApplyEdits(0, Edit{Start: 5, End: 9}); !errors.Is(err, ErrRange) {
		t.Fatalf("err = %v, want ErrRange", err)
	}
	if d.Versions() != 1 {
		t.Fatalf("rejected batch still committed: %d versions", d.Versions())
	}
}

func TestVersionConflictNotApplied(t *testing.T) {
	d := NewDocument([]byte("abc"))
	mustApply(t, d, 0, Edit{Start: 0, End: 1, Text: []byte("A")})
	if _, _, err := d.ApplyEdits(0, Edit{Start: 0, End: 1, Text: []byte("Z")}); !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("err = %v, want ErrVersionConflict", err)
	}
	if d.Versions() != 2 {
		t.Fatalf("conflicting batch committed: %d versions", d.Versions())
	}
	if got := string(d.Latest().Runes()); got != "Abc" {
		t.Fatalf("latest = %q, want %q", got, "Abc")
	}
}

func TestOldVersionRetained(t *testing.T) {
	d := NewDocument([]byte("aé水"))
	v0 := d.Latest()
	runes0, maps0 := v0.Runes(), v0.Mappings()

	mustApply(t, d, 0, Edit{Start: 0, End: 1, Text: []byte("b")})

	if !slices.Equal(v0.Runes(), runes0) || !slices.Equal(v0.Mappings(), maps0) {
		t.Fatal("old version mutated after committing a new one")
	}
	if got := string(v0.Runes()); got != "aé水" {
		t.Fatalf("old version content = %q", got)
	}
	// Mutating a previously returned slice must not affect the version.
	maps0[0].Start = -99
	if v0.Mappings()[0].Start != 0 {
		t.Fatal("version state aliases a slice it handed out")
	}
}

// TestCrossEdgeRepairJoin: an edit supplies the continuation byte that
// completes a dangling lead byte of the old version.
func TestCrossEdgeRepairJoin(t *testing.T) {
	d := NewDocument([]byte{'x', 0xC3, 'y'}) // x, FFFD, y
	v1, diff := mustApply(t, d, 0, Edit{Start: 2, End: 3, Text: []byte{0xA9, 'z'}})

	want := []rune{'x', 'é', 'z'}
	if !slices.Equal(v1.Runes(), want) {
		t.Fatalf("runes = %U, want %U", v1.Runes(), want)
	}
	if diff.NetRunes != 0 {
		t.Fatalf("NetRunes = %d, want 0", diff.NetRunes)
	}
	// The repair must extend left of the edit to swallow the dangling 0xC3.
	if diff.OldBytes != [2]int{1, 3} || diff.NewBytes != [2]int{1, 4} {
		t.Fatalf("affected bytes = %v/%v", diff.OldBytes, diff.NewBytes)
	}
}

// TestCrossEdgeRepairBreak: deleting a byte splits a formerly valid
// sequence into replacement characters.
func TestCrossEdgeRepairBreak(t *testing.T) {
	d := NewDocument([]byte("aéb"))                        // é = C3 A9 at [1,3)
	v1, diff := mustApply(t, d, 0, Edit{Start: 2, End: 3}) // delete A9

	want := []rune{'a', utf8.RuneError, 'b'}
	if !slices.Equal(v1.Runes(), want) {
		t.Fatalf("runes = %U, want %U", v1.Runes(), want)
	}
	if diff.NetRunes != 0 {
		t.Fatalf("NetRunes = %d, want 0", diff.NetRunes)
	}
	if diff.Migrate(0) != 0 || diff.Migrate(1) != -1 || diff.Migrate(2) != 2 {
		t.Fatalf("migration = %d %d %d", diff.Migrate(0), diff.Migrate(1), diff.Migrate(2))
	}
}

// TestRandomEditsVsFullDecode applies random edit batches and checks the
// incremental result against a full re-decode, plus affected-range
// minimality and migration consistency.
func TestRandomEditsVsFullDecode(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	pool := []byte{'a', 'z', ' ', 0xC3, 0xA9, 0xE4, 0xB8, 0xAD, 0xF0, 0x9F, 0x98, 0x80, 0xBF, 0xC0, 0xFF, 0xED, 0xA0}
	randBytes := func(n int) []byte {
		b := make([]byte, n)
		for i := range b {
			b[i] = pool[rng.Intn(len(pool))]
		}
		return b
	}

	base := randBytes(200)
	d := NewDocument(base)

	for round := 0; round < 500; round++ {
		old := d.Latest()
		nEdits := 1 + rng.Intn(4)
		var edits []Edit
		pos := 0
		for k := 0; k < nEdits; k++ {
			if pos > len(old.Bytes()) {
				break
			}
			start := pos + rng.Intn(len(old.Bytes())-pos+1)
			end := start + rng.Intn(len(old.Bytes())-start+1)
			edits = append(edits, Edit{Start: start, End: end, Text: randBytes(rng.Intn(9))})
			pos = end + 1
		}

		v, diff, err := d.ApplyEdits(old.ID(), edits...)
		if err != nil {
			t.Fatalf("round %d: %v", round, err)
		}

		// 1. Incremental result must equal a full re-decode.
		wantRunes, wantMaps := DecodeAll(v.Bytes())
		if !slices.Equal(v.Runes(), wantRunes) || !slices.Equal(v.Mappings(), wantMaps) {
			t.Fatalf("round %d: incremental decode disagrees with full decode", round)
		}

		// 2. The affected range must hug the edited byte ranges.
		affStart, affEnd := edits[0].Start, edits[len(edits)-1].End
		if diff.OldBytes[0] > affStart || affStart-diff.OldBytes[0] > 7 {
			t.Fatalf("round %d: left edge %d, edit starts %d", round, diff.OldBytes[0], affStart)
		}
		if diff.OldBytes[1] < affEnd || diff.OldBytes[1]-affEnd > 8 {
			t.Fatalf("round %d: right edge %d, edit ends %d", round, diff.OldBytes[1], affEnd)
		}

		// 3. Outside the affected range, code points and mappings are
		//    preserved; Migrate must agree.
		oldRunes, oldMaps := old.Runes(), old.Mappings()
		newRunes, newMaps := v.Runes(), v.Mappings()
		if len(newRunes)-len(oldRunes) != diff.NetRunes {
			t.Fatalf("round %d: NetRunes = %d, actual %d", round, diff.NetRunes, len(newRunes)-len(oldRunes))
		}
		for i := 0; i < len(oldRunes); i++ {
			mi := diff.Migrate(i)
			if i < diff.OldRunes[0] || i >= diff.OldRunes[1] {
				if mi < 0 || newRunes[mi] != oldRunes[i] || newMaps[mi].End-newMaps[mi].Start != oldMaps[i].End-oldMaps[i].Start {
					t.Fatalf("round %d: code point %d not preserved at %d", round, i, mi)
				}
			} else if mi != -1 {
				t.Fatalf("round %d: affected code point %d migrated to %d", round, i, mi)
			}
		}
		// Head mappings are byte-identical; tail mappings shift by delta.
		for i := 0; i < diff.OldRunes[0]; i++ {
			if newMaps[i] != oldMaps[i] {
				t.Fatalf("round %d: head mapping %d changed", round, i)
			}
		}
		delta := diff.NewBytes[1] - diff.OldBytes[1]
		for i := diff.OldRunes[1]; i < len(oldRunes); i++ {
			mi := diff.Migrate(i)
			if newMaps[mi].Start != oldMaps[i].Start+delta || newMaps[mi].End != oldMaps[i].End+delta {
				t.Fatalf("round %d: tail mapping %d not shifted by %d", round, i, delta)
			}
		}
	}
}

// TestMultiEditBatch applies several edits in one batch against base
// coordinates.
func TestMultiEditBatch(t *testing.T) {
	d := NewDocument([]byte("one two three"))
	v1, diff := mustApply(t, d, 0,
		Edit{Start: 0, End: 3, Text: []byte("1")},
		Edit{Start: 4, End: 7, Text: []byte("2")},
		Edit{Start: 8, End: 13, Text: []byte("3")},
	)
	if got := string(v1.Runes()); got != "1 2 3" {
		t.Fatalf("content = %q", got)
	}
	if diff.NetRunes != -8 {
		t.Fatalf("NetRunes = %d, want -8", diff.NetRunes)
	}
	// Touching ranges are allowed (no overlap).
	d2 := NewDocument([]byte("abc"))
	if _, _, err := d2.ApplyEdits(0, Edit{Start: 0, End: 1, Text: []byte("x")}, Edit{Start: 1, End: 2, Text: []byte("y")}); err != nil {
		t.Fatalf("touching edits rejected: %v", err)
	}
}
