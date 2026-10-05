package register

import (
	"fmt"
	"reflect"
	"testing"
)

func dataOf(vals []Value) []string {
	out := make([]string, len(vals))
	for i, v := range vals {
		out[i] = v.Data
	}
	return out
}

func TestVersionVectorCompare(t *testing.T) {
	cases := []struct {
		a, b VersionVector
		want Ordering
	}{
		{VersionVector{"A": 1}, VersionVector{"A": 1}, Equal},
		{VersionVector{"A": 1}, VersionVector{"A": 2}, Before},
		{VersionVector{"A": 2}, VersionVector{"A": 1}, After},
		{VersionVector{"A": 1}, VersionVector{"B": 1}, Concurrent},
		{VersionVector{"A": 1, "B": 1}, VersionVector{"A": 1}, After},
		{VersionVector{"A": 2, "B": 1}, VersionVector{"A": 1, "B": 2}, Concurrent},
	}
	for _, c := range cases {
		if got := c.a.Compare(c.b); got != c.want {
			t.Errorf("Compare(%v, %v) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// 因果后写覆盖前写：同一副本顺序写，后者覆盖前者。
func TestCausalOverwriteSameReplica(t *testing.T) {
	r := New("A")
	r.Write("first")
	r.Write("second")
	got, ok := r.Get()
	if !ok || got != "second" {
		t.Fatalf("Get() = %q, %v; want %q, true", got, ok, "second")
	}
	if len(r.Values()) != 1 {
		t.Fatalf("Values() = %v; want exactly one value", r.Values())
	}
}

// 因果后写覆盖前写：跨副本观察到旧写之后再写，旧写被覆盖。
func TestCausalOverwriteAcrossReplicas(t *testing.T) {
	a, b := New("A"), New("B")
	a.Write("from-A")
	b.Merge(a)
	b.Write("from-B") // B observed A's write, so this supersedes it
	a.Merge(b)
	for _, r := range []*MVRegister{a, b} {
		got, ok := r.Get()
		if !ok || got != "from-B" {
			t.Fatalf("replica %s: Get() = %q, %v; want %q, true", r.ID(), got, ok, "from-B")
		}
	}
}

// 并发写全部保留且按 ID 展示。
func TestConcurrentWritesAllPreserved(t *testing.T) {
	a, b, c := New("A"), New("B"), New("C")
	a.Write("alpha")
	b.Write("beta")
	c.Write("gamma")

	merge := New("M")
	merge.Merge(a)
	merge.Merge(b)
	merge.Merge(c)

	vals := merge.Values()
	if got, want := dataOf(vals), []string{"alpha", "beta", "gamma"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Values() data = %v; want %v (sorted by replica ID)", got, want)
	}
	for i, id := range []string{"A", "B", "C"} {
		if vals[i].ReplicaID != id {
			t.Fatalf("Values()[%d].ReplicaID = %q; want %q", i, vals[i].ReplicaID, id)
		}
	}
	if got := merge.String(); got != "A=alpha; B=beta; C=gamma" {
		t.Fatalf("String() = %q; want %q", got, "A=alpha; B=beta; C=gamma")
	}
	if _, ok := merge.Get(); ok {
		t.Fatal("Get() ok = true; want false for concurrent values")
	}
}

// 解决冲突的写入须观察全部当前版本：解决后旧并发版本全部消失，
// 且与仍持有旧版本的滞后副本合并也不会复活旧值。
func TestResolvingWriteObservesAllVersions(t *testing.T) {
	a, b := New("A"), New("B")
	a.Write("x")
	b.Write("y")

	resolver := New("R")
	resolver.Merge(a)
	resolver.Merge(b)
	if len(resolver.Values()) != 2 {
		t.Fatalf("resolver sees %d values; want 2 concurrent values", len(resolver.Values()))
	}
	resolver.Write("resolved") // observes both A:1 and B:1

	vals := resolver.Values()
	if len(vals) != 1 || vals[0].Data != "resolved" {
		t.Fatalf("after resolve, Values() = %v; want single resolved value", vals)
	}
	if vals[0].Version.Compare(VersionVector{"A": 1, "B": 1, "R": 1}) != Equal {
		t.Fatalf("resolved version = %v; want to observe all prior versions {A:1 B:1 R:1}", vals[0].Version)
	}

	// A stale replica merging the resolution must drop its old write.
	a.Merge(resolver)
	if got, ok := a.Get(); !ok || got != "resolved" {
		t.Fatalf("stale replica after merge: Get() = %q, %v; want resolved", got, ok)
	}
	// Merging the resolution must not resurrect old concurrent values.
	resolver.Merge(a)
	resolver.Merge(b)
	if got, ok := resolver.Get(); !ok || got != "resolved" {
		t.Fatalf("resolver after re-merge: Get() = %q, %v; want resolved", got, ok)
	}
}

func snapshot(r *MVRegister) []Value { return r.Values() }

func equalState(a, b []Value) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ReplicaID != b[i].ReplicaID || a[i].Data != b[i].Data ||
			a[i].Version.Compare(b[i].Version) != Equal {
			return false
		}
	}
	return true
}

// 构造三个并发写副本。
func threeConcurrent() (*MVRegister, *MVRegister, *MVRegister) {
	a, b, c := New("A"), New("B"), New("C")
	a.Write("1")
	b.Write("2")
	c.Write("3")
	return a, b, c
}

// 交换律：Merge(a,b) == Merge(b,a)。
func TestMergeCommutative(t *testing.T) {
	a, b, c := threeConcurrent()
	ab, ba := New("AB"), New("BA")
	ab.Merge(a)
	ab.Merge(b)
	ab.Merge(c)
	ba.Merge(c)
	ba.Merge(b)
	ba.Merge(a)
	if !equalState(snapshot(ab), snapshot(ba)) {
		t.Fatalf("merge order changed result: %v vs %v", snapshot(ab), snapshot(ba))
	}
}

// 结合律：(a∪b)∪c == a∪(b∪c)。
func TestMergeAssociative(t *testing.T) {
	a, b, c := threeConcurrent()
	left := New("L")
	left.Merge(a)
	left.Merge(b)
	left.Merge(c)

	bc := New("BC")
	bc.Merge(b)
	bc.Merge(c)
	right := New("R")
	right.Merge(a)
	right.Merge(bc)

	if !equalState(snapshot(left), snapshot(right)) {
		t.Fatalf("associativity violated: %v vs %v", snapshot(left), snapshot(right))
	}
}

// 幂等：重复合并同一状态不改变结果。
func TestMergeIdempotent(t *testing.T) {
	a, b, _ := threeConcurrent()
	r := New("R")
	r.Merge(a)
	r.Merge(b)
	first := snapshot(r)
	r.Merge(a)
	r.Merge(b)
	r.Merge(r)
	if !equalState(first, snapshot(r)) {
		t.Fatalf("idempotence violated: %v vs %v", first, snapshot(r))
	}
}

// 不丢并发写：任意合并次序下所有并发写都保留。
func TestMergeNeverLosesConcurrentWrites(t *testing.T) {
	a, b, c := threeConcurrent()
	orders := [][3]*MVRegister{
		{a, b, c}, {a, c, b}, {b, a, c},
		{b, c, a}, {c, a, b}, {c, b, a},
	}
	for i, ord := range orders {
		r := New(fmt.Sprintf("R%d", i))
		for _, src := range ord {
			r.Merge(src)
		}
		if got, want := dataOf(r.Values()), []string{"1", "2", "3"}; !reflect.DeepEqual(got, want) {
			t.Fatalf("order %d: values = %v; want %v, no concurrent write lost", i, got, want)
		}
	}
}

// 收敛：所有副本两两合并后达到一致状态。
func TestConvergence(t *testing.T) {
	a, b, c := threeConcurrent()
	a.Merge(b)
	a.Merge(c)
	b.Merge(a)
	b.Merge(c)
	c.Merge(a)
	c.Merge(b)
	if !equalState(snapshot(a), snapshot(b)) || !equalState(snapshot(b), snapshot(c)) {
		t.Fatalf("replicas diverged: %v / %v / %v", snapshot(a), snapshot(b), snapshot(c))
	}
	if n := len(a.Values()); n != 3 {
		t.Fatalf("converged replica keeps %d values; want 3 concurrent writes", n)
	}
}
