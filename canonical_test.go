package q220

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math/rand"
	"sort"
	"strconv"
	"testing"
)

func iri(v string) Node   { return Node{Type: IRI, Value: v} }
func blank(v string) Node { return Node{Type: Blank, Value: v} }

func TestEncodeNode(t *testing.T) {
	got := EncodeNode(iri("ab"))
	want := []byte{'I', 0, 0, 0, 2, 'a', 'b'}
	if !bytes.Equal(got, want) {
		t.Fatalf("IRI 编码错误: got %v want %v", got, want)
	}

	got = EncodeNode(blank("007"))
	want = []byte{'B', 0, 0, 0, 1, '7'}
	if !bytes.Equal(got, want) {
		t.Fatalf("匿名节点应无前导零: got %v want %v", got, want)
	}

	utf8 := "东京"
	got = EncodeNode(iri(utf8))
	if got[0] != 'I' || binary.BigEndian.Uint32(got[1:5]) != uint32(len([]byte(utf8))) {
		t.Fatalf("UTF-8 长度前缀错误: %v", got)
	}

	a := EncodeNode(iri("x"))
	b := EncodeNode(blank("x"))
	if bytes.Equal(a, b) {
		t.Fatalf("IRI 与匿名节点同文本时编码必须可区分")
	}
}

func TestDedupAndOrder(t *testing.T) {
	t1 := Triple{blank("b1"), iri("p"), iri("u")}
	t2 := Triple{blank("b2"), iri("p"), iri("u")}
	in := []Triple{t1, t1, t2, t1}

	res, err := Canonicalize(in)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Triples) != 2 {
		t.Fatalf("重复三元组未去重: %d", len(res.Triples))
	}
	for i := 1; i < len(res.Triples); i++ {
		prev := encodeCanonicalTriple(res.Triples[i-1])
		cur := encodeCanonicalTriple(res.Triples[i])
		if bytes.Compare(prev, cur) > 0 {
			t.Fatalf("三元组未按编码排序")
		}
	}

	joined := []byte{}
	for _, ct := range res.Triples {
		joined = append(joined, encodeCanonicalTriple(ct)...)
	}
	if !bytes.Equal(joined, res.Encoding) {
		t.Fatalf("Encoding 应为排序三元组编码的顺序连接")
	}
}

func encodeCanonicalTriple(ct CanonicalTriple) []byte {
	parts := [3][]byte{
		encodeCanonicalNode(ct.Subject),
		encodeCanonicalNode(ct.Predicate),
		encodeCanonicalNode(ct.Object),
	}
	out := []byte{}
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

func TestValidation(t *testing.T) {
	cases := []struct {
		name string
		in   []Triple
		err  error
	}{
		{"谓语是匿名节点", []Triple{{blank("b"), blank("p"), iri("u")}}, ErrPredicateIRI},
		{"空 IRI", []Triple{{iri(""), iri("p"), iri("u")}}, ErrEmptyNode},
		{"空匿名标识", []Triple{{blank("b"), iri("p"), blank("")}}, ErrEmptyNode},
		{"非法节点类型", []Triple{{Node{Type: 9}, iri("p"), iri("u")}}, ErrInvalidNodeType},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := Canonicalize(c.in); err != c.err {
				t.Fatalf("got %v want %v", err, c.err)
			}
		})
	}

	var many []Triple
	for i := 0; i <= MaxBlanks; i++ {
		many = append(many, Triple{blank("b" + strconv.Itoa(i)), iri("p"), iri("u")})
	}
	if _, err := Canonicalize(many); !errors.Is(err, ErrTooManyBlanks) {
		t.Fatalf("超匿名节点上限: got %v want %v", err, ErrTooManyBlanks)
	}
}

// TestSymmetricRing 构造 8 个匿名节点的有向对称环：所有节点同构，
// 与全排列参考对拍，并验证结构分区与下界剪枝实际减少了搜索量。
func TestSymmetricRing(t *testing.T) {
	var in []Triple
	n := MaxBlanks
	for i := 0; i < n; i++ {
		s := blank("b" + strconv.Itoa(i))
		o := blank("b" + strconv.Itoa((i+1)%n))
		in = append(in, Triple{s, iri("rel"), o})
	}

	res, stats, err := CanonicalizeWithStats(in)
	if err != nil {
		t.Fatal(err)
	}
	wantSeq, wantPerm := bruteForceCanonical(t, in)
	assertBruteForce(t, res, wantSeq, wantPerm)

	if stats.Bounds == 0 {
		t.Fatalf("对称环上应发生下界剪枝, stats=%+v", stats)
	}
	if stats.Leaves >= factorial(n) {
		t.Fatalf("剪枝未减少叶子数: leaves=%d, n!=%d", stats.Leaves, factorial(n))
	}
	t.Logf("对称环统计: %+v (n!=%d)", stats, factorial(n))
}

// TestIsolatedComponents 构造两个结构完全相同、互不相连的分量。
func TestIsolatedComponents(t *testing.T) {
	in := []Triple{
		{blank("x1"), iri("p"), iri("root")},
		{blank("x1"), iri("q"), blank("x2")},
		{blank("y1"), iri("p"), iri("root")},
		{blank("y1"), iri("q"), blank("y2")},
	}
	res, stats, err := CanonicalizeWithStats(in)
	if err != nil {
		t.Fatal(err)
	}
	wantSeq, wantPerm := bruteForceCanonical(t, in)
	assertBruteForce(t, res, wantSeq, wantPerm)
	t.Logf("孤立分量统计: %+v", stats)
}

// TestIRIBlankSameText 验证同字 IRI 与匿名节点不会混淆。
func TestIRIBlankSameText(t *testing.T) {
	in := []Triple{
		{iri("node1"), iri("same"), blank("node1")},
		{blank("node1"), iri("same"), iri("node2")},
	}
	res, err := Canonicalize(in)
	if err != nil {
		t.Fatal(err)
	}
	wantSeq, wantPerm := bruteForceCanonical(t, in)
	assertBruteForce(t, res, wantSeq, wantPerm)

	for _, m := range res.Mapping {
		if m.Source.Type == IRI && m.Source.Value == "node1" {
			if m.Canonical.Type != IRI || m.Canonical.Value != "node1" {
				t.Fatalf("IRI 映射被匿名编号污染: %+v", m)
			}
		}
	}
}

// TestRandomRenameInvariance 随机生成图，对匿名节点随机改名后规范编码不变，
// 且每幅随机图的结果与全排列暴力参考完全一致（含同值时的排列 tie-break）。
func TestRandomRenameInvariance(t *testing.T) {
	rng := rand.New(rand.NewSource(20261111))
	for iter := 0; iter < 200; iter++ {
		blankCount := rng.Intn(MaxBlanks + 1)
		iriCount := 1 + rng.Intn(4)
		predCount := 1 + rng.Intn(2)

		blanks := make([]Node, blankCount)
		for i := range blanks {
			blanks[i] = blank("old_" + strconv.Itoa(i))
		}
		iris := make([]Node, iriCount)
		for i := range iris {
			iris[i] = iri("http://example.com/i" + strconv.Itoa(i))
		}
		preds := make([]Node, predCount)
		for i := range preds {
			preds[i] = iri("http://example.org/p" + strconv.Itoa(i))
		}
		all := append([]Node{}, blanks...)
		all = append(all, iris...)

		tripleCount := 1 + rng.Intn(12)
		var in []Triple
		for k := 0; k < tripleCount; k++ {
			s := all[rng.Intn(len(all))]
			o := all[rng.Intn(len(all))]
			p := preds[rng.Intn(len(preds))]
			in = append(in, Triple{s, p, o})
		}

		res, err := Canonicalize(in)
		if err != nil {
			t.Fatal(err)
		}
		wantSeq, wantPerm := bruteForceCanonical(t, in)
		assertBruteForce(t, res, wantSeq, wantPerm)

		// 对匿名节点做随机双射改名，结构完全不变。
		perm := rng.Perm(blankCount)
		rename := map[string]string{}
		for i := 0; i < blankCount; i++ {
			rename["old_"+strconv.Itoa(i)] = "new_" + strconv.Itoa(perm[i])
		}
		renamed := make([]Triple, len(in))
		for i, tr := range in {
			renamed[i] = Triple{
				Subject:   renameNode(tr.Subject, rename),
				Predicate: tr.Predicate,
				Object:    renameNode(tr.Object, rename),
			}
		}
		res2, err := Canonicalize(renamed)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(res.Encoding, res2.Encoding) {
			t.Fatalf("迭代 %d: 随机改名后规范编码变化\nold=%x\nnew=%x", iter, res.Encoding, res2.Encoding)
		}
	}
}

func renameNode(n Node, rename map[string]string) Node {
	if n.Type == Blank {
		return blank(rename[n.Value])
	}
	return n
}

func TestEmptyInput(t *testing.T) {
	res, err := Canonicalize(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Encoding) != 0 || res.BlankCount != 0 || len(res.Mapping) != 0 {
		t.Fatalf("空输入应得到空规范结果, got %+v", res)
	}
}

// bruteForceCanonical 枚举匿名节点到 0..n-1 的全部双射（字典序），
// 返回最小排序三元组编码序列与对应排列，作为独立参考实现。
func bruteForceCanonical(t *testing.T, in []Triple) ([][]byte, []int) {
	t.Helper()
	g, err := buildGraph(in)
	if err != nil {
		t.Fatal(err)
	}
	n := g.blankCount
	perm := make([]int, n)
	used := make([]bool, n)

	var bestSeq [][]byte
	var bestPerm []int

	var enumerate func(pos int)
	enumerate = func(pos int) {
		if pos == n {
			seq := encodeTriples(g, append([]int(nil), perm...), -1)
			if bestSeq == nil || compareTripleSeq(seq, bestSeq) < 0 ||
				(compareTripleSeq(seq, bestSeq) == 0 && permLess(perm, bestPerm)) {
				bestSeq = seq
				bestPerm = append([]int(nil), perm...)
			}
			return
		}
		for d := 0; d < n; d++ {
			if used[d] {
				continue
			}
			perm[pos] = d
			used[d] = true
			enumerate(pos + 1)
			used[d] = false
		}
	}
	enumerate(0)
	return bestSeq, bestPerm
}

func assertBruteForce(t *testing.T, res *Result, wantSeq [][]byte, wantPerm []int) {
	t.Helper()
	joined := []byte{}
	for _, b := range wantSeq {
		joined = append(joined, b...)
	}
	if !bytes.Equal(res.Encoding, joined) {
		t.Fatalf("规范编码与全排列参考不一致\ngot  %x\nwant %x", res.Encoding, joined)
	}

	gotPerm := make([]int, res.BlankCount)
	type pair struct {
		label string
		num   int
	}
	var pairs []pair
	for _, m := range res.Mapping {
		if m.Source.Type != Blank {
			continue
		}
		num, err := strconv.Atoi(m.Canonical.Value)
		if err != nil {
			t.Fatal(err)
		}
		pairs = append(pairs, pair{m.Source.Value, num})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].label < pairs[j].label })
	for i, p := range pairs {
		gotPerm[i] = p.num
	}
	if !equalInts(gotPerm, wantPerm) {
		t.Fatalf("匿名节点排列与参考不一致: got %v want %v", gotPerm, wantPerm)
	}
}

func equalInts(a, b []int) bool {
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

func factorial(n int) int {
	v := 1
	for i := 2; i <= n; i++ {
		v *= i
	}
	return v
}
