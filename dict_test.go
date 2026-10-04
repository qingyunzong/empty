package dict

import (
	"math/rand"
	"sort"
	"strings"
	"testing"
)

// levenshtein is the reference full dynamic programming implementation over
// code points with insert/delete/replace, all at cost 1.
func levenshtein(a, b []rune) int {
	prev := make([]int, len(b)+1)
	for j := range prev {
		prev[j] = j
	}
	for i, ra := range a {
		cur := make([]int, len(b)+1)
		cur[0] = i + 1
		for j, rb := range b {
			cost := 0
			if ra != rb {
				cost = 1
			}
			cur[j+1] = minOf3(prev[j+1]+1, cur[j]+1, prev[j]+cost)
		}
		prev = cur
	}
	return prev[len(b)]
}

// bruteForce ranks all words of the snapshot by the required ordering using
// the reference DP.
func bruteForce(words map[string]int, query string, maxDist int) []Result {
	var out []Result
	for w, f := range words {
		d := levenshtein([]rune(query), []rune(w))
		if d <= maxDist {
			out = append(out, Result{Word: w, Distance: d, Freq: f})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Distance != b.Distance {
			return a.Distance < b.Distance
		}
		if a.Freq != b.Freq {
			return a.Freq > b.Freq
		}
		return strings.Compare(a.Word, b.Word) < 0
	})
	return out
}

func build(words map[string]int) *Snapshot {
	s := New()
	for w, f := range words {
		s = s.Add(w, f)
	}
	return s
}

func TestSearchMatchesFullDP(t *testing.T) {
	words := map[string]int{
		"hello": 100, "hell": 50, "help": 80, "helloo": 10, "jello": 30,
		"world": 90, "word": 40, "would": 70, "he": 5, "her": 15,
		"你好": 60, "你好啊": 20, "世界": 55, "好": 45, "你好世界": 5,
		"héllo": 25, "hèllo": 12, "café": 35, "cafe": 65, "": 1,
		"a": 2, "ab": 3, "abc": 4, "abcd": 8, "abcde": 16,
	}
	s := build(words)
	queries := []string{"hello", "你好", "cafe", "", "abcd", "xyz", "héllo", "界"}
	for _, q := range queries {
		got, stats := s.Search(q)
		want := bruteForce(words, q, MaxDistance)
		if len(got) != len(want) {
			t.Fatalf("query %q: got %d results, want %d\ngot:  %v\nwant: %v", q, len(got), len(want), got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("query %q result %d: got %+v, want %+v\ngot:  %v\nwant: %v", q, i, got[i], want[i], got, want)
			}
		}
		t.Logf("query %q: %d results, %d nodes visited", q, len(got), stats.NodesVisited)
	}
}

func TestSearchMatchesFullDPRandom(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	alphabet := []rune("abcdeé你好吗")
	words := make(map[string]int)
	for len(words) < 400 {
		n := 1 + rng.Intn(6)
		rs := make([]rune, n)
		for i := range rs {
			rs[i] = alphabet[rng.Intn(len(alphabet))]
		}
		words[string(rs)] = 1 + rng.Intn(1000)
	}
	s := build(words)
	if s.Len() != len(words) {
		t.Fatalf("Len = %d, want %d", s.Len(), len(words))
	}
	totalVisited := 0
	for i := 0; i < 50; i++ {
		n := rng.Intn(5)
		qs := make([]rune, n)
		for j := range qs {
			qs[j] = alphabet[rng.Intn(len(alphabet))]
		}
		q := string(qs)
		got, stats := s.Search(q)
		want := bruteForce(words, q, MaxDistance)
		if len(got) != len(want) {
			t.Fatalf("query %q: got %d results, want %d", q, len(got), len(want))
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("query %q result %d: got %+v, want %+v", q, i, got[i], want[i])
			}
		}
		totalVisited += stats.NodesVisited
	}
	t.Logf("random cross-check: 50 queries over %d words, total nodes visited = %d", len(words), totalVisited)
}

func TestRankingTieBreaks(t *testing.T) {
	// All candidates at distance 1 from "cat": frequency descending, then
	// byte order ascending for equal frequencies.
	words := map[string]int{
		"bat": 10, "cat": 1, "cut": 10, "at": 10, "cats": 5, "cot": 7,
	}
	s := build(words)
	got, _ := s.Search("cat")
	var order []string
	for _, r := range got {
		order = append(order, r.Word)
	}
	want := []string{"cat", "at", "bat", "cut", "cot", "cats"}
	if strings.Join(order, ",") != strings.Join(want, ",") {
		t.Fatalf("order = %v, want %v", order, want)
	}
}

func TestSnapshotPersistence(t *testing.T) {
	s0 := New()
	s1 := s0.Add("apple", 10).Add("apply", 20).Add("apex", 30)
	s2 := s1.Remove("apple")
	s3 := s2.Add("apple", 99).Add("app", 40)

	if s0.Len() != 0 || s1.Len() != 3 || s2.Len() != 2 || s3.Len() != 4 {
		t.Fatalf("sizes: %d %d %d %d", s0.Len(), s1.Len(), s2.Len(), s3.Len())
	}
	if _, ok := s0.Freq("apple"); ok {
		t.Fatal("s0 must stay empty")
	}
	if f, ok := s1.Freq("apple"); !ok || f != 10 {
		t.Fatalf("s1 apple = %d,%v", f, ok)
	}
	if _, ok := s2.Freq("apple"); ok {
		t.Fatal("s2 must not contain apple")
	}
	if f, ok := s1.Freq("apply"); !ok || f != 20 {
		t.Fatalf("s1 apply = %d,%v", f, ok)
	}
	if f, ok := s3.Freq("apple"); !ok || f != 99 {
		t.Fatalf("s3 apple = %d,%v", f, ok)
	}

	r1, v1 := s1.Search("apple")
	r2, v2 := s2.Search("apple")
	r3, _ := s3.Search("apple")
	if len(r1) != 2 || len(r2) != 1 || len(r3) != 3 {
		t.Fatalf("result counts: %d %d %d", len(r1), len(r2), len(r3))
	}
	for _, r := range r2 {
		if r.Word == "apple" {
			t.Fatal("s2 search returned removed word")
		}
	}
	if r3[0].Word != "apple" || r3[0].Distance != 0 || r3[0].Freq != 99 {
		t.Fatalf("s3 top hit = %+v", r3[0])
	}
	t.Logf("snapshot searches: s1 visited %d nodes, s2 visited %d nodes", v1.NodesVisited, v2.NodesVisited)
}

func TestNodesVisitedAccounting(t *testing.T) {
	words := map[string]int{
		"hello": 100, "hell": 50, "help": 80, "world": 90, "word": 40,
		"你好": 60, "世界": 55, "你好世界": 5,
	}
	s := build(words)
	got, stats := s.Search("hello")
	if len(got) == 0 {
		t.Fatal("expected results")
	}
	if stats.NodesVisited <= 0 {
		t.Fatalf("NodesVisited = %d, want > 0", stats.NodesVisited)
	}
	nodes := countNodes(s.root)
	if stats.NodesVisited > nodes {
		t.Fatalf("NodesVisited = %d exceeds trie size %d", stats.NodesVisited, nodes)
	}
	// Determinism: identical query must visit the same number of nodes.
	_, stats2 := s.Search("hello")
	if stats.NodesVisited != stats2.NodesVisited {
		t.Fatalf("non-deterministic visit count: %d vs %d", stats.NodesVisited, stats2.NodesVisited)
	}
	t.Logf("query \"hello\": visited %d of %d trie nodes", stats.NodesVisited, nodes)
}

func countNodes(n *node) int {
	if n == nil {
		return 0
	}
	total := 1
	for _, c := range n.children {
		total += countNodes(c)
	}
	return total
}
