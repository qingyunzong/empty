package chainrepl

import (
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

var allIDs = []int{0, 1, 2}

// 事件重排验收：写永不丢失，且已发布序列始终是提交序列的连续前缀。
func TestEventReorderingWritesNeverLost(t *testing.T) {
	for seed := int64(1); seed <= 50; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rng := rand.New(rand.NewSource(seed))
			c := NewCluster(allIDs, []int{0, 1, 2}, rng)
			const total = 25
			var writes []string
			for len(writes) < total || c.Pending() > 0 {
				switch {
				case len(writes) < total && (c.Pending() == 0 || rng.Intn(3) == 0):
					w := fmt.Sprintf("w%02d", len(writes)+1)
					writes = append(writes, w)
					c.Submit(w)
				case len(writes) < total && c.Pending() > 0 && rng.Intn(4) == 0:
					perm := append([]int(nil), allIDs...)
					rng.Shuffle(len(perm), func(i, j int) { perm[i], perm[j] = perm[j], perm[i] })
					c.Reconfigure(perm) // 拓扑切换，绑定新纪元
				default:
					c.Step()
				}
				assertPublishedPrefix(t, c, writes)
			}
			assertConverged(t, c, writes)
		})
	}
}

// 只有连续前缀可发布：乱序到达的写在空洞补齐前不得提交。
func TestOnlyContiguousPrefixPublishes(t *testing.T) {
	c := NewCluster(allIDs, []int{0, 1, 2}, rand.New(rand.NewSource(1)))
	c.Submit("a")
	c.Submit("b")

	// 先把 seq=2 推到尾节点：seq=1 缺失，任何节点都不得提交。
	for c.DeliverNext(func(m Message) bool { return m.Kind == KindWrite && m.Seq == 2 }) {
	}
	for _, id := range allIDs {
		if got := c.Node(id).Commit(); got != 0 {
			t.Fatalf("node %d committed with a hole: commit=%d", id, got)
		}
	}
	if pub := c.Published(); len(pub) != 0 {
		t.Fatalf("published over a hole: %v", pub)
	}

	// 补上 seq=1 后尾节点连续提交 1、2，确认反向传播到头才发布。
	for c.DeliverNext(func(m Message) bool { return m.Kind == KindWrite && m.Seq == 1 }) {
	}
	if pub := c.Published(); len(pub) != 0 {
		t.Fatalf("published before acks reached head: %v", pub)
	}
	for c.DeliverNext(func(m Message) bool { return m.Kind == KindAck }) {
	}
	if pub := c.Published(); !reflect.DeepEqual(pub, []string{"a", "b"}) {
		t.Fatalf("published=%v, want [a b]", pub)
	}
	for _, id := range allIDs {
		if got := c.Node(id).Commit(); got != 2 {
			t.Fatalf("node %d commit=%d, want 2", id, got)
		}
	}
}

// 旧确认不误用：跨纪元的确认不得提交当前条目；缺失条目的确认被忽略；
// 而真正属于旧纪元的确认在拓扑切换后依然有效。
func TestStaleAckNeverMisused(t *testing.T) {
	t.Run("forged epoch ack ignored", func(t *testing.T) {
		c := NewCluster(allIDs, []int{0, 1, 2}, rand.New(rand.NewSource(1)))
		c.Submit("a")
		c.DeliverNext(func(m Message) bool { return m.Kind == KindWrite && m.To == 0 })
		c.Inject(Message{Kind: KindAck, From: 1, To: 0, Epoch: 99, Seq: 1})
		c.Inject(Message{Kind: KindAck, From: 1, To: 0, Epoch: 1, Seq: 5}) // 无此条目
		// 只投递确认（此刻队列里没有合法确认，写仍停在中途）。
		for c.DeliverNext(func(m Message) bool { return m.Kind == KindAck }) {
		}
		if got := c.Node(0).Commit(); got != 0 {
			t.Fatalf("head committed on stale ack: commit=%d", got)
		}
		if pub := c.Published(); len(pub) != 0 {
			t.Fatalf("published on stale ack: %v", pub)
		}
	})

	t.Run("genuine old-epoch ack still counts", func(t *testing.T) {
		c := NewCluster(allIDs, []int{0, 1, 2}, rand.New(rand.NewSource(1)))
		c.Submit("x")
		for c.DeliverNext(func(m Message) bool { return m.Kind == KindWrite }) {
		}
		// 尾已提交，确认在途；此刻切换拓扑（新纪元），旧确认不得被误拒。
		c.Reconfigure([]int{0, 1, 2})
		c.Drain()
		if pub := c.Published(); !reflect.DeepEqual(pub, []string{"x"}) {
			t.Fatalf("published=%v, want [x]", pub)
		}
		if len(c.Violations()) != 0 {
			t.Fatalf("violations: %v", c.Violations())
		}
	})
}

// 节点重启后依据日志补洞：崩溃期间丢失的写经状态同步补齐，
// 新写绑定切换后的新纪元。
func TestRestartFillsHolesFromLog(t *testing.T) {
	rng := rand.New(rand.NewSource(7))
	c := NewCluster(allIDs, []int{0, 1, 2}, rng)
	var writes []string
	submit := func() {
		w := fmt.Sprintf("w%02d", len(writes)+1)
		writes = append(writes, w)
		c.Submit(w)
	}
	for i := 0; i < 5; i++ {
		submit()
	}
	c.Drain()
	assertConverged(t, c, writes)

	// 中间节点崩溃：后续写无法越过它，确认丢失。
	c.Crash(1)
	for i := 0; i < 3; i++ {
		submit()
	}
	c.Drain()
	if pub := c.Published(); len(pub) != 5 {
		t.Fatalf("published past crashed node: %v", pub)
	}

	// 拓扑切换绕过故障节点，绑定新纪元；同步补洞后继续提交。
	c.Reconfigure([]int{0, 2})
	c.Drain()
	assertPublishedPrefix(t, c, writes)
	if pub := c.Published(); len(pub) != 8 {
		t.Fatalf("published=%d, want 8", len(pub))
	}

	// 重启节点重新入链：凭持久日志 + 邻居同步补齐所有空洞。
	c.Restart(1)
	c.Reconfigure([]int{0, 1, 2})
	c.Drain()
	assertConverged(t, c, writes)

	// 新写必须携带当前纪元。
	seq := c.Submit("w09")
	writes = append(writes, "w09")
	c.Drain()
	e, ok := c.Node(2).Entry(seq)
	if !ok {
		t.Fatalf("tail missing seq=%d", seq)
	}
	if e.Epoch != c.Epoch() {
		t.Fatalf("write epoch=%d, want current epoch %d", e.Epoch, c.Epoch())
	}
	assertConverged(t, c, writes)
}

// 尾节点崩溃后切换拓扑，重启尾节点再入链，日志收敛。
func TestTailCrashAndRejoin(t *testing.T) {
	rng := rand.New(rand.NewSource(11))
	c := NewCluster(allIDs, []int{0, 1, 2}, rng)
	var writes []string
	for i := 0; i < 4; i++ {
		w := fmt.Sprintf("w%02d", i+1)
		writes = append(writes, w)
		c.Submit(w)
	}
	c.Drain()
	assertConverged(t, c, writes)

	c.Crash(2)
	c.Reconfigure([]int{0, 1})
	for i := 0; i < 3; i++ {
		w := fmt.Sprintf("w%02d", len(writes)+1)
		writes = append(writes, w)
		c.Submit(w)
	}
	c.Drain()
	assertPublishedPrefix(t, c, writes)

	c.Restart(2)
	c.Reconfigure([]int{0, 1, 2})
	c.Drain()
	assertConverged(t, c, writes)
}

func assertPublishedPrefix(t *testing.T, c *Cluster, writes []string) {
	t.Helper()
	for i, v := range c.Published() {
		if i >= len(writes) || v != writes[i] {
			t.Fatalf("published %v is not a prefix of submitted %v", c.Published(), writes)
		}
	}
}

func assertConverged(t *testing.T, c *Cluster, writes []string) {
	t.Helper()
	if v := c.Violations(); len(v) > 0 {
		t.Fatalf("safety violations: %v", v)
	}
	if pub := c.Published(); !reflect.DeepEqual(pub, writes) {
		t.Fatalf("published=%v, want %v", pub, writes)
	}
	for _, id := range allIDs {
		n := c.Node(id)
		if n.Commit() != len(writes) {
			t.Fatalf("node %d commit=%d, want %d", id, n.Commit(), len(writes))
		}
		if n.LogLen() != len(writes) {
			t.Fatalf("node %d logLen=%d, want %d", id, n.LogLen(), len(writes))
		}
		for i, w := range writes {
			e, ok := n.Entry(i + 1)
			if !ok || e.Value != w {
				t.Fatalf("node %d seq=%d entry=%+v ok=%v, want %q", id, i+1, e, ok, w)
			}
		}
	}
}
