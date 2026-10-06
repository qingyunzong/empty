package segindex

import (
	"fmt"
	"math/rand"
	"reflect"
	"sort"
	"strings"
	"testing"
)

func TestTermPositionsAndPhraseConsecutive(t *testing.T) {
	ix := NewIndex()
	ix.Put("a", "the quick brown fox jumps")
	ix.Put("b", "quick red brown fox")      // quick/brown not adjacent
	ix.Put("c", "brown quick fox")          // wrong order
	ix.Put("d", "quick quick brown cattle") // adjacent at 1..2

	snap := ix.Snapshot()
	if got := snap.Term("quick"); !reflect.DeepEqual(got, []string{"a", "b", "c", "d"}) {
		t.Fatalf("term quick = %v", got)
	}
	if got := snap.Phrase("quick", "brown"); !reflect.DeepEqual(got, []string{"a", "d"}) {
		t.Fatalf("phrase quick brown = %v, want [a d]", got)
	}
	if got := snap.Phrase("the", "quick", "brown", "fox"); !reflect.DeepEqual(got, []string{"a"}) {
		t.Fatalf("4-word phrase = %v, want [a]", got)
	}
	if got := snap.Phrase("brown", "quick"); !reflect.DeepEqual(got, []string{"c"}) {
		t.Fatalf("ordered phrase = %v, want [c]", got)
	}
	// "quick fox" is consecutive only in c ("brown quick fox"); in a they
	// are separated by "brown".
	if got := snap.Phrase("quick", "fox"); !reflect.DeepEqual(got, []string{"c"}) {
		t.Fatalf("phrase quick fox = %v, want [c]", got)
	}
	if got := snap.Phrase("quick", "jumps"); len(got) != 0 {
		t.Fatalf("non-consecutive phrase matched: %v", got)
	}
}

func TestAtomicReplaceAndSnapshotIsolation(t *testing.T) {
	ix := NewIndex()
	ix.Put("doc", "old cat text")
	before := ix.Snapshot()
	ix.Put("doc", "new dog text") // same ID: atomic replace
	after := ix.Snapshot()

	if got := before.Term("cat"); !reflect.DeepEqual(got, []string{"doc"}) {
		t.Fatalf("old snapshot lost old doc: %v", got)
	}
	if got := before.Term("dog"); len(got) != 0 {
		t.Fatalf("old snapshot sees future write: %v", got)
	}
	if got := after.Term("dog"); !reflect.DeepEqual(got, []string{"doc"}) {
		t.Fatalf("new snapshot missing replacement: %v", got)
	}
	if got := after.Term("cat"); len(got) != 0 {
		t.Fatalf("replaced version still visible: %v", got)
	}
	if got := after.Phrase("new", "dog", "text"); !reflect.DeepEqual(got, []string{"doc"}) {
		t.Fatalf("phrase on replaced doc = %v", got)
	}
}

func TestDeleteVersions(t *testing.T) {
	ix := NewIndex()
	ix.Put("x", "alpha beta")
	ix.Put("y", "alpha gamma")
	s1 := ix.Snapshot()
	ix.Delete("x")
	s2 := ix.Snapshot()
	ix.Put("x", "alpha delta") // re-add after delete
	s3 := ix.Snapshot()

	if got := s1.Term("alpha"); !reflect.DeepEqual(got, []string{"x", "y"}) {
		t.Fatalf("s1 = %v", got)
	}
	if got := s2.Term("alpha"); !reflect.DeepEqual(got, []string{"y"}) {
		t.Fatalf("s2 = %v, delete not applied", got)
	}
	if got := s3.Term("alpha"); !reflect.DeepEqual(got, []string{"x", "y"}) {
		t.Fatalf("s3 = %v, re-add not visible", got)
	}
	if got := s3.Term("beta"); len(got) != 0 {
		t.Fatalf("s3 resurrected pre-delete version: %v", got)
	}
}

func TestCompactionNoResurrection(t *testing.T) {
	ix := NewIndex()
	ix.Put("keep", "lorem ipsum dolor")
	ix.Put("gone", "lorem sit amet")
	ix.Put("upd", "version one apple")
	old := ix.Snapshot() // taken while all history is live
	ix.Delete("gone")
	ix.Put("upd", "version two banana")

	ix.Compact()
	fresh := ix.Snapshot()

	if got := fresh.Term("lorem"); !reflect.DeepEqual(got, []string{"keep"}) {
		t.Fatalf("after compact, deleted doc resurrected: %v", got)
	}
	if got := fresh.Term("amet"); len(got) != 0 {
		t.Fatalf("tombstoned term survived compaction: %v", got)
	}
	if got := fresh.Term("apple"); len(got) != 0 {
		t.Fatalf("superseded version survived compaction: %v", got)
	}
	if got := fresh.Phrase("version", "two", "banana"); !reflect.DeepEqual(got, []string{"upd"}) {
		t.Fatalf("phrase after compact = %v", got)
	}
	// Old snapshot still sees full history through immutable segments.
	if got := old.Term("amet"); !reflect.DeepEqual(got, []string{"gone"}) {
		t.Fatalf("old snapshot broken by compaction: %v", got)
	}
	if got := old.Term("apple"); !reflect.DeepEqual(got, []string{"upd"}) {
		t.Fatalf("old snapshot lost superseded version: %v", got)
	}
	// Writes after compaction keep working.
	ix.Put("keep", "lorem post compact")
	if got := ix.Snapshot().Phrase("lorem", "post", "compact"); !reflect.DeepEqual(got, []string{"keep"}) {
		t.Fatalf("post-compaction write broken: %v", got)
	}
}

// bruteTerm scans the original text word by word.
func bruteTerm(model map[string]string, term string) []string {
	var ids []string
	for id, text := range model {
		for _, tok := range tokenize(text) {
			if tok == term {
				ids = append(ids, id)
				break
			}
		}
	}
	sort.Strings(ids)
	return ids
}

// brutePhrase scans for the phrase at consecutive positions in the original text.
func brutePhrase(model map[string]string, phrase []string) []string {
	var ids []string
	for id, text := range model {
		toks := tokenize(text)
		for i := 0; i+len(phrase) <= len(toks); i++ {
			match := true
			for j := range phrase {
				if toks[i+j] != phrase[j] {
					match = false
					break
				}
			}
			if match {
				ids = append(ids, id)
				break
			}
		}
	}
	sort.Strings(ids)
	return ids
}

func copyModel(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// eq compares ID lists treating nil and empty as equal.
func eq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestRandomizedAgainstBruteForce(t *testing.T) {
	rng := rand.New(rand.NewSource(20261006))
	vocab := []string{"alpha", "beta", "gamma", "delta", "omega", "kappa", "sigma", "theta"}
	ix := NewIndex()
	live := map[string]string{}
	type snapPair struct {
		snap  *Snapshot
		model map[string]string
	}
	snaps := []snapPair{{ix.Snapshot(), copyModel(live)}}

	randomText := func() string {
		n := 1 + rng.Intn(12)
		words := make([]string, n)
		for i := range words {
			words[i] = vocab[rng.Intn(len(vocab))]
		}
		return strings.Join(words, " ")
	}
	checkQueries := func(step int) {
		sp := snaps[rng.Intn(len(snaps))]
		term := vocab[rng.Intn(len(vocab))]
		if got, want := sp.snap.Term(term), bruteTerm(sp.model, term); !eq(got, want) {
			t.Fatalf("step %d: Term(%q) = %v, brute force = %v", step, term, got, want)
		}
		plen := 1 + rng.Intn(3)
		phrase := make([]string, plen)
		for i := range phrase {
			phrase[i] = vocab[rng.Intn(len(vocab))]
		}
		if got, want := sp.snap.Phrase(phrase...), brutePhrase(sp.model, phrase); !eq(got, want) {
			t.Fatalf("step %d: Phrase(%v) = %v, brute force = %v", step, phrase, got, want)
		}
	}

	for step := 0; step < 600; step++ {
		switch rng.Intn(10) {
		case 0, 1, 2, 3: // put (possibly replacing an existing ID)
			id := fmt.Sprintf("doc%d", rng.Intn(12))
			text := randomText()
			ix.Put(id, text)
			live[id] = text
		case 4: // atomic batch
			used := map[int]bool{}
			var docs []Document
			for i := 0; i < 1+rng.Intn(3); i++ {
				n := rng.Intn(12)
				if used[n] {
					continue
				}
				used[n] = true
				id := fmt.Sprintf("doc%d", n)
				text := randomText()
				docs = append(docs, Document{ID: id, Text: text})
				live[id] = text
			}
			ix.PutAll(docs...)
		case 5, 6: // delete
			id := fmt.Sprintf("doc%d", rng.Intn(12))
			ix.Delete(id)
			delete(live, id)
		case 7: // snapshot
			snaps = append(snaps, snapPair{ix.Snapshot(), copyModel(live)})
		case 8: // compact: every snapshot must still agree with brute force
			ix.Compact()
			for i, sp := range snaps {
				for _, term := range vocab {
					if got, want := sp.snap.Term(term), bruteTerm(sp.model, term); !eq(got, want) {
						t.Fatalf("step %d snap %d: post-compact Term(%q) = %v, want %v", step, i, term, got, want)
					}
				}
			}
		}
		checkQueries(step)
		checkQueries(step)
	}
}
