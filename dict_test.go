package dictsearch

import (
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// levenshtein computes the edit distance with a full DP matrix over
// code points (unit-cost insert/delete/substitute). It is the
// reference implementation used to cross-check Search.
func levenshtein(a, b string) int {
	ar, br := []rune(a), []rune(b)
	dp := make([][]int, len(ar)+1)
	for i := range dp {
		dp[i] = make([]int, len(br)+1)
	}
	for i := 0; i <= len(ar); i++ {
		dp[i][0] = i
	}
	for j := 0; j <= len(br); j++ {
		dp[0][j] = j
	}
	for i := 1; i <= len(ar); i++ {
		for j := 1; j <= len(br); j++ {
			cost := 0
			if ar[i-1] != br[j-1] {
				cost = 1
			}
			dp[i][j] = min3(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+cost)
		}
	}
	return dp[len(ar)][len(br)]
}

// bruteForce ranks all dictionary words within MaxDistance of query
// using the full DP, applying the same ordering as Search.
func bruteForce(d *Dictionary, query string) []Match {
	var matches []Match
	for _, w := range d.Words() {
		dist := levenshtein(w, query)
		if dist <= MaxDistance {
			matches = append(matches, Match{Word: w, Distance: dist, Freq: d.Freq(w)})
		}
	}
	sort.Slice(matches, func(i, j int) bool { return less(matches[i], matches[j]) })
	return matches
}

func build(words ...string) *Dictionary {
	d := New()
	for _, w := range words {
		d = d.Add(w)
	}
	return d
}

func TestSearchMatchesFullDP(t *testing.T) {
	d := build(
		"cat", "cats", "car", "cart", "cast", "ca", "at", "bat", "rat",
		"cut", "coat", "scat", "category", "dog", "do", "door",
		"你好", "你好啊", "你好吗", "世界", "héllo", "hello", "hell",
		"", "a", "ab", "abc",
	)
	queries := []string{"cat", "ca", "cats", "dog", "xyz", "", "你好", "hello", "héllo", "at", "abcd"}
	for _, q := range queries {
		got, stats := d.Search(q)
		want := bruteForce(d, q)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("query %q:\n got %v\nwant %v", q, got, want)
		}
		if stats.NodesVisited < 1 || stats.NodesVisited > d.NodeCount() {
			t.Errorf("query %q: NodesVisited=%d out of range [1,%d]",
				q, stats.NodesVisited, d.NodeCount())
		}
		t.Logf("query %q: %d matches, visited %d/%d nodes",
			q, len(got), stats.NodesVisited, d.NodeCount())
	}
}

func TestRankingOrder(t *testing.T) {
	d := New()
	d = d.Add("cat")       // freq 1
	d = d.Add("bat")       // freq 1
	d = d.Add("bat")       // freq 2
	d = d.Add("cat")       // freq 2
	d = d.Add("cut")       // freq 1
	d = d.Add("cut")       // freq 1
	d = d.Add("cut")       // freq 3
	d = d.Add("at")        // distance 1
	d = d.Add("cats")      // distance 1
	d = d.Add("cathedral") // too far
	d = d.Add("dog")       // too far

	got, _ := d.Search("cat")
	want := []Match{
		{Word: "cat", Distance: 0, Freq: 2},
		{Word: "at", Distance: 1, Freq: 1},
		{Word: "bat", Distance: 1, Freq: 2},
		{Word: "cats", Distance: 1, Freq: 1},
		{Word: "cut", Distance: 1, Freq: 3},
	}
	// distance asc; ties: freq desc, then byte order.
	want = []Match{
		{Word: "cat", Distance: 0, Freq: 2},
		{Word: "cut", Distance: 1, Freq: 3},
		{Word: "bat", Distance: 1, Freq: 2},
		{Word: "at", Distance: 1, Freq: 1},
		{Word: "cats", Distance: 1, Freq: 1},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}

func TestByteOrderTieBreak(t *testing.T) {
	// Same distance and frequency: byte (UTF-8) order decides.
	d := build("zat", "bat", "aat", "中at", "äat")
	got, _ := d.Search("cat")
	var words []string
	for _, m := range got {
		if m.Distance != 1 {
			continue
		}
		words = append(words, m.Word)
	}
	want := []string{"aat", "bat", "zat", "äat", "中at"}
	if !reflect.DeepEqual(words, want) {
		t.Errorf("got %v, want %v", words, want)
	}
}

func TestSnapshotsArePersistent(t *testing.T) {
	d0 := New()
	d1 := d0.Add("cat").Add("car")
	d2 := d1.Add("cart").Remove("cat")
	d3 := d2.Remove("car").Remove("cart")

	if d0.Len() != 0 || d0.Freq("cat") != 0 {
		t.Errorf("d0 mutated: %+v", d0.Words())
	}
	if got := d1.Words(); !reflect.DeepEqual(got, []string{"car", "cat"}) {
		t.Errorf("d1 = %v", got)
	}
	if got := d2.Words(); !reflect.DeepEqual(got, []string{"car", "cart"}) {
		t.Errorf("d2 = %v", got)
	}
	if d3.Len() != 0 {
		t.Errorf("d3 = %v", d3.Words())
	}

	// Search results on an old snapshot must not change after later
	// snapshots are created.
	before, _ := d1.Search("cat")
	d1.Add("cats").Remove("car").Add("cat")
	after, _ := d1.Search("cat")
	if !reflect.DeepEqual(before, after) {
		t.Errorf("old snapshot search changed: %v -> %v", before, after)
	}
	if d1.Freq("cat") != 1 {
		t.Errorf("d1 cat freq = %d, want 1", d1.Freq("cat"))
	}
}

func TestRemoveAbsentKeepsSnapshot(t *testing.T) {
	d := build("cat")
	same := d.Remove("dog")
	if same != d {
		t.Errorf("removing absent word should return the same snapshot")
	}
}

func TestFuzzyRandomCrossCheck(t *testing.T) {
	rng := rand.New(rand.NewSource(42))
	alphabet := []rune("abc猫狗")
	var words []string
	for i := 0; i < 200; i++ {
		n := rng.Intn(6)
		rs := make([]rune, n)
		for j := range rs {
			rs[j] = alphabet[rng.Intn(len(alphabet))]
		}
		words = append(words, string(rs))
	}
	d := New()
	for _, w := range words {
		d = d.Add(w)
		if rng.Intn(3) == 0 {
			d = d.Add(w) // bump some frequencies
		}
	}
	for i := 0; i < 50; i++ {
		q := words[rng.Intn(len(words))]
		got, stats := d.Search(q)
		want := bruteForce(d, q)
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("query %q:\n got %v\nwant %v", q, got, want)
		}
		if stats.NodesVisited < 1 || stats.NodesVisited > d.NodeCount() {
			t.Fatalf("query %q: NodesVisited=%d, node count=%d",
				q, stats.NodesVisited, d.NodeCount())
		}
	}
	t.Logf("dictionary: %d distinct words, %d nodes", d.Len(), d.NodeCount())
}
