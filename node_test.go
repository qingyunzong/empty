package causalmsg

import (
	"errors"
	"fmt"
	"testing"
)

// 固定因果历史：
//
//	m1: A:1
//	m2: A:2            依赖 m1
//	m3: B:1 {A:1}      依赖 m1
//	m4: A:3 {B:1}      依赖 m2, m3
//	m5: B:2 {A:3,B:1}  依赖 m4
//	m6: D:1            独立链，与 m1..m5 并发
func history() []Message {
	return []Message{
		{ID: "m1", From: "A", Clock: VectorClock{"A": 1}, Payload: []byte("m1")},
		{ID: "m2", From: "A", Clock: VectorClock{"A": 2}, Payload: []byte("m2")},
		{ID: "m3", From: "B", Clock: VectorClock{"A": 1, "B": 1}, Payload: []byte("m3")},
		{ID: "m4", From: "A", Clock: VectorClock{"A": 3, "B": 1}, Payload: []byte("m4")},
		{ID: "m5", From: "B", Clock: VectorClock{"A": 3, "B": 2}, Payload: []byte("m5")},
		{ID: "m6", From: "D", Clock: VectorClock{"D": 1}, Payload: []byte("m6")},
	}
}

// happensBefore 由向量时钟推导：a 因果先于 b 当且仅当
// a.Clock <= b.Clock 且二者不相等。
func happensBefore(a, b Message) bool {
	return a.Clock.LessEqual(b.Clock) && !a.Clock.Equal(b.Clock)
}

// assertLinearExtension 校验交付序列是 happens-before 的线性扩展：
// 任意先交付的消息不得因果依赖于后交付的消息。
func assertLinearExtension(t *testing.T, delivered []Message) {
	t.Helper()
	for i := 0; i < len(delivered); i++ {
		for j := i + 1; j < len(delivered); j++ {
			if happensBefore(delivered[j], delivered[i]) {
				t.Fatalf("因果倒置: %s 先于 %s 交付，但 %s 依赖 %s",
					delivered[j].ID, delivered[i].ID, delivered[i].ID, delivered[j].ID)
			}
		}
	}
}

func permutations(items []Message, fn func([]Message)) {
	var rec func(prefix, rest []Message)
	rec = func(prefix, rest []Message) {
		if len(rest) == 0 {
			fn(prefix)
			return
		}
		for i := range rest {
			next := append([]Message{}, rest[:i]...)
			next = append(next, rest[i+1:]...)
			rec(append(append([]Message{}, prefix...), rest[i]), next)
		}
	}
	rec(nil, items)
}

// 乱序重放：以全部 720 种排列灌入同一历史，
// 交付结果必须完整且保持因果序。
func TestOutOfOrderReplay(t *testing.T) {
	msgs := history()
	permutations(msgs, func(order []Message) {
		n := NewNode("C")
		for _, m := range order {
			if err := n.Receive(m); err != nil {
				t.Fatalf("Receive(%s) 出错: %v", m.ID, err)
			}
		}
		delivered := n.Delivered()
		if len(delivered) != len(msgs) {
			t.Fatalf("交付 %d 条，期望 %d 条", len(delivered), len(msgs))
		}
		assertLinearExtension(t, delivered)
		if pending := n.Close(); len(pending) != 0 {
			t.Fatalf("关闭后仍有 %d 条未交付", len(pending))
		}
	})
}

// 全部合法拓扑序：每种拓扑序灌入时，每条消息都应立即就绪，
// 交付顺序与灌入顺序完全一致。
func TestAllTopologicalOrders(t *testing.T) {
	msgs := history()
	preds := make(map[string][]string)
	for _, a := range msgs {
		for _, b := range msgs {
			if happensBefore(a, b) {
				preds[b.ID] = append(preds[b.ID], a.ID)
			}
		}
	}
	byID := make(map[string]Message)
	for _, m := range msgs {
		byID[m.ID] = m
	}

	count := 0
	var topo func(done map[string]bool, order []Message)
	topo = func(done map[string]bool, order []Message) {
		if len(order) == len(msgs) {
			count++
			n := NewNode("C")
			for _, m := range order {
				if err := n.Receive(m); err != nil {
					t.Fatalf("Receive(%s) 出错: %v", m.ID, err)
				}
			}
			delivered := n.Delivered()
			for i, m := range order {
				if delivered[i].ID != m.ID {
					t.Fatalf("拓扑序灌入时第 %d 条交付为 %s，期望 %s", i, delivered[i].ID, m.ID)
				}
			}
			return
		}
		for _, m := range msgs {
			if done[m.ID] {
				continue
			}
			ready := true
			for _, p := range preds[m.ID] {
				if !done[p] {
					ready = false
					break
				}
			}
			if !ready {
				continue
			}
			done[m.ID] = true
			topo(done, append(order, m))
			delete(done, m.ID)
		}
	}
	topo(make(map[string]bool), nil)

	if count == 0 {
		t.Fatal("未枚举到任何拓扑序")
	}
	t.Logf("共核对 %d 种合法拓扑序", count)
}

// 缺前置的消息保留在缓冲区，不因任何时间因素强行交付；
// 前置到达后按因果序连带交付。
func TestMissingPrerequisiteBuffered(t *testing.T) {
	msgs := history()
	n := NewNode("C")

	if err := n.Receive(msgs[4]); err != nil { // m5 依赖 m4
		t.Fatal(err)
	}
	if err := n.Receive(msgs[2]); err != nil { // m3 依赖 m1
		t.Fatal(err)
	}
	if got := len(n.Delivered()); got != 0 {
		t.Fatalf("缺前置时交付了 %d 条消息", got)
	}

	pending := n.Pending()
	if len(pending) != 2 {
		t.Fatalf("缓冲区应有 2 条，实际 %d 条", len(pending))
	}
	for _, p := range pending {
		if len(p.Missing) == 0 {
			t.Fatalf("缓冲消息 %s 未报告缺失依赖", p.Message.ID)
		}
	}

	for _, m := range []Message{msgs[0], msgs[1], msgs[2], msgs[3], msgs[5]} { // 补齐 m1..m4 与 m6
		if err := n.Receive(m); err != nil {
			t.Fatal(err)
		}
	}
	delivered := n.Delivered()
	if len(delivered) != len(msgs) {
		t.Fatalf("交付 %d 条，期望 %d 条", len(delivered), len(msgs))
	}
	assertLinearExtension(t, delivered)
}

// 重复 ID：内容一致幂等忽略；内容不一致拒绝。
func TestDuplicateID(t *testing.T) {
	n := NewNode("C")
	m := Message{ID: "x", From: "A", Clock: VectorClock{"A": 1}, Payload: []byte("hello")}

	if err := n.Receive(m); err != nil {
		t.Fatal(err)
	}
	dup := Message{ID: "x", From: "A", Clock: VectorClock{"A": 1}, Payload: []byte("hello")}
	if err := n.Receive(dup); err != nil {
		t.Fatalf("内容一致的重复 ID 应幂等忽略: %v", err)
	}
	if got := len(n.Delivered()); got != 1 {
		t.Fatalf("重复 ID 被重复交付，共 %d 条", got)
	}

	cases := []Message{
		{ID: "x", From: "A", Clock: VectorClock{"A": 1}, Payload: []byte("tampered")},
		{ID: "x", From: "B", Clock: VectorClock{"A": 1}, Payload: []byte("hello")},
		{ID: "x", From: "A", Clock: VectorClock{"A": 2}, Payload: []byte("hello")},
	}
	for i, c := range cases {
		err := n.Receive(c)
		var ce *ConflictError
		if !errors.As(err, &ce) {
			t.Fatalf("用例 %d: 期望 ConflictError，实际 %v", i, err)
		}
	}
	if got := len(n.Delivered()); got != 1 {
		t.Fatalf("冲突消息被交付，共 %d 条", got)
	}
}

// Close 输出依赖未满足的消息及其缺失前置，关闭后拒绝接收。
func TestCloseReportsUnmetDependencies(t *testing.T) {
	n := NewNode("C")
	m5 := history()[4] // 需要 A:3 与 B:2
	if err := n.Receive(m5); err != nil {
		t.Fatal(err)
	}

	pending := n.Close()
	if len(pending) != 1 || pending[0].Message.ID != "m5" {
		t.Fatalf("Close 应报告 m5 未满足，实际 %+v", pending)
	}
	want := []Dependency{
		{Node: "A", Have: 0, Need: 3},
		{Node: "B", Have: 0, Need: 2},
	}
	got := pending[0].Missing
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("缺失依赖 = %v，期望 %v", got, want)
	}

	if err := n.Receive(history()[0]); !errors.Is(err, ErrClosed) {
		t.Fatalf("关闭后 Receive 应返回 ErrClosed，实际 %v", err)
	}
}

// 端到端：两个节点广播并交换消息，因果依赖跨节点生效。
func TestBroadcastExchange(t *testing.T) {
	a, b := NewNode("A"), NewNode("B")

	a1 := a.Broadcast([]byte("a1"))
	if err := b.Receive(a1); err != nil {
		t.Fatal(err)
	}
	b1 := b.Broadcast([]byte("b1")) // 因果依赖 a1

	// a 先收到自己后续广播之前的乱序 b1 场景不成立，
	// 这里直接验证正常交换后双方时钟与交付因果。
	if err := a.Receive(b1); err != nil {
		t.Fatal(err)
	}
	a2 := a.Broadcast([]byte("a2")) // 依赖 a1, b1

	c := NewNode("C")
	if err := c.Receive(a2); err != nil { // 缺前置，应缓冲
		t.Fatal(err)
	}
	if got := len(c.Delivered()); got != 0 {
		t.Fatalf("缺前置时交付了 %d 条", got)
	}
	for _, m := range []Message{a1, b1} {
		if err := c.Receive(m); err != nil {
			t.Fatal(err)
		}
	}
	delivered := c.Delivered()
	if len(delivered) != 3 {
		t.Fatalf("交付 %d 条，期望 3 条", len(delivered))
	}
	assertLinearExtension(t, delivered)
	if delivered[2].ID != a2.ID {
		t.Fatalf("a2 应最后交付，实际最后为 %s", delivered[2].ID)
	}
}
