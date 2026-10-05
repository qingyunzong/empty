package numalloc_test

import (
	"errors"
	"fmt"
	"math/rand"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"numalloc"
)

// harness 维护测试集群: 一个分配器 + 若干节点, 并记录所有已发出号码。
type harness struct {
	t      *testing.T
	dir    string
	f      *numalloc.Faults
	al     *numalloc.Allocator
	nodes  map[string]*numalloc.Node
	seq    atomic.Int64
	mu     sync.Mutex
	issued map[int64]string // 号码 -> 发出它的节点
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	f := numalloc.NewFaults()
	al, err := numalloc.OpenAllocator(filepath.Join(dir, "alloc"), f)
	if err != nil {
		t.Fatalf("open allocator: %v", err)
	}
	t.Cleanup(func() { al.Close() })
	return &harness{
		t: t, dir: dir, f: f, al: al,
		nodes:  make(map[string]*numalloc.Node),
		issued: make(map[int64]string),
	}
}

func (h *harness) reqID() string {
	return fmt.Sprintf("req-%d", h.seq.Add(1))
}

// openOrRestart 打开(或模拟重启)节点。
func (h *harness) openOrRestart(id string) *numalloc.Node {
	var n *numalloc.Node
	for {
		var err error
		n, err = numalloc.OpenNode(filepath.Join(h.dir, "node-"+id), id, h.al, h.f)
		if err == nil {
			break
		}
		if errors.Is(err, numalloc.ErrPersist) {
			h.f.Clear() // 瞬时故障, 清除后重试
			continue
		}
		h.t.Fatalf("open node %s: %v", id, err)
	}
	h.nodes[id] = n
	return n
}

func (h *harness) reopenAllocator() {
	if err := h.al.Reopen(); err != nil {
		h.t.Fatalf("reopen allocator: %v", err)
	}
}

// ensure 带重试地确保节点有可用区间。
func (h *harness) ensure(n *numalloc.Node, size int64) error {
	reqID := h.reqID()
	for {
		err := n.EnsureRange(size, reqID)
		switch {
		case err == nil:
			return nil
		case errors.Is(err, numalloc.ErrBroken):
			h.f.Clear() // 瞬时故障, 清除后重试
			h.reopenAllocator()
		case errors.Is(err, numalloc.ErrAckLost), errors.Is(err, numalloc.ErrPersist):
			// 已提交但应答丢失 / 未提交: 同 reqID 重试
			h.f.Clear()
		default:
			return err
		}
	}
}

// issue 从节点发出一个号码并登记; 返回 false 表示节点已退役。
func (h *harness) issue(n *numalloc.Node, size int64) (int64, bool) {
	for {
		if err := h.ensure(n, size); err != nil {
			if errors.Is(err, numalloc.ErrClosed) {
				return 0, false
			}
			h.t.Fatalf("ensure range for %s: %v", n.ID(), err)
		}
		num, err := n.Next()
		switch {
		case err == nil:
			h.record(n.ID(), num)
			return num, true
		case errors.Is(err, numalloc.ErrAckLost):
			// 游标已落盘但号码丢失: 成为空洞, 重试拿下一个
			h.f.Clear()
		case errors.Is(err, numalloc.ErrPersist):
			// 未提交, 重试安全
			h.f.Clear()
		case errors.Is(err, numalloc.ErrExhausted):
			// 空洞烧穿了剩余区间: 重新取段
			continue
		case errors.Is(err, numalloc.ErrClosed):
			return 0, false
		default:
			h.t.Fatalf("next from %s: %v", n.ID(), err)
		}
	}
}

func (h *harness) record(nodeID string, num int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if prev, dup := h.issued[num]; dup {
		h.t.Fatalf("DUPLICATE number %d issued by %q and %q", num, prev, nodeID)
	}
	h.issued[num] = nodeID
}

// audit 核对全历史编号唯一, 且每个已发出号码都落在某段已消费区间内。
func (h *harness) audit() []numalloc.LeaseSpan {
	h.t.Helper()
	h.f.Clear()
	cursors := make(map[string]int64)
	for id, n := range h.nodes {
		st, err := n.State()
		if err != nil {
			h.t.Fatalf("read state of %s: %v", id, err)
		}
		if st.HasLease {
			cursors[id] = st.Cursor
		}
	}
	spans, err := h.al.Audit(cursors)
	if err != nil {
		h.t.Fatalf("audit failed: %v", err)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for num, nodeID := range h.issued {
		covered := false
		for _, s := range spans {
			if num >= s.Lo && num < s.Cursor {
				covered = true
				break
			}
		}
		if !covered {
			h.t.Fatalf("issued number %d (node %q) not covered by any consumed interval", num, nodeID)
		}
	}
	return spans
}

// TestAllocateAndRestart: 基本分配 + 重启后续用未消费尾部。
func TestAllocateAndRestart(t *testing.T) {
	h := newHarness(t)
	n1 := h.openOrRestart("n1")

	for want := int64(1); want <= 5; want++ {
		got, ok := h.issue(n1, 5)
		if !ok || got != want {
			t.Fatalf("got %d ok=%v, want %d", got, ok, want)
		}
	}
	// 区间 [1,5] 已耗尽, 再发应触发换段。
	if _, err := n1.Next(); !errors.Is(err, numalloc.ErrExhausted) {
		t.Fatalf("want ErrExhausted, got %v", err)
	}

	// 重启: 续用新段尾部, 不重发。
	n1 = h.openOrRestart("n1")
	if got, _ := h.issue(n1, 5); got != 6 {
		t.Fatalf("after restart got %d, want 6", got)
	}
	n1 = h.openOrRestart("n1")
	if got, _ := h.issue(n1, 5); got != 7 {
		t.Fatalf("after 2nd restart got %d, want 7", got)
	}

	// 另一节点拿到不重叠的新段。
	n2 := h.openOrRestart("n2")
	if got, _ := h.issue(n2, 3); got != 11 {
		t.Fatalf("node n2 got %d, want 11", got)
	}
	h.audit()
}

// TestTransferClosesOldGeneration: 转让先关闭旧代, 新代续用尾部。
func TestTransferClosesOldGeneration(t *testing.T) {
	h := newHarness(t)
	n1 := h.openOrRestart("n1")
	for i := 0; i < 4; i++ { // 消费 1..4
		h.issue(n1, 10)
	}

	n2 := h.openOrRestart("n2")
	if err := numalloc.Transfer(n1, n2, h.reqID()); err != nil {
		t.Fatalf("transfer: %v", err)
	}

	// 旧代立即停发, 重启后依然停发。
	if _, err := n1.Next(); !errors.Is(err, numalloc.ErrClosed) {
		t.Fatalf("old generation: want ErrClosed, got %v", err)
	}
	n1 = h.openOrRestart("n1")
	if _, err := n1.Next(); !errors.Is(err, numalloc.ErrClosed) {
		t.Fatalf("old generation after restart: want ErrClosed, got %v", err)
	}

	// 新代从游标 5 继续, 不重发 1..4。
	for want := int64(5); want <= 10; want++ {
		got, ok := h.issue(n2, 10)
		if !ok || got != want {
			t.Fatalf("new generation got %d ok=%v, want %d", got, ok, want)
		}
	}
	h.audit()
}

// TestTransferAckLossRetry: 转让各阶段确认丢失后, 同 reqID 重试不重复发号。
func TestTransferAckLossRetry(t *testing.T) {
	h := newHarness(t)
	n1 := h.openOrRestart("n1")
	for i := 0; i < 3; i++ {
		h.issue(n1, 10)
	}
	n2 := h.openOrRestart("n2")
	reqID := h.reqID()

	// 阶段 2 (close) 应答丢失。
	h.f.Enable(numalloc.FaultCloseAck)
	if err := numalloc.Transfer(n1, n2, reqID); !errors.Is(err, numalloc.ErrAckLost) {
		t.Fatalf("want ErrAckLost, got %v", err)
	}
	h.f.Disable(numalloc.FaultCloseAck)

	// 阶段 3 (grant) 应答丢失。
	h.f.Enable(numalloc.FaultGrantAck)
	if err := numalloc.Transfer(n1, n2, reqID); !errors.Is(err, numalloc.ErrAckLost) {
		t.Fatalf("want ErrAckLost, got %v", err)
	}
	h.f.Disable(numalloc.FaultGrantAck)

	// 重试完成转让。
	if err := numalloc.Transfer(n1, n2, reqID); err != nil {
		t.Fatalf("retry transfer: %v", err)
	}
	if got, _ := h.issue(n2, 10); got != 4 {
		t.Fatalf("new generation got %d, want 4", got)
	}
	h.audit()
}

// TestAllocAckLoss: 分配应答丢失, 重试返回同一租约, 计数器不重复扣减。
func TestAllocAckLoss(t *testing.T) {
	h := newHarness(t)
	n1 := h.openOrRestart("n1")

	h.f.Enable(numalloc.FaultAllocAck)
	if err := n1.EnsureRange(4, "a1"); !errors.Is(err, numalloc.ErrAckLost) {
		t.Fatalf("want ErrAckLost, got %v", err)
	}
	h.f.Disable(numalloc.FaultAllocAck)

	if err := n1.EnsureRange(4, "a1"); err != nil {
		t.Fatalf("retry ensure: %v", err)
	}
	st, _ := n1.State()
	if st.Lo != 1 || st.Hi != 4 {
		t.Fatalf("lease [%d,%d], want [1,4]", st.Lo, st.Hi)
	}

	// 下一个节点应紧接 5 开始, 证明丢失的应答没有造成计数器重复扣减。
	n2 := h.openOrRestart("n2")
	if got, _ := h.issue(n2, 3); got != 5 {
		t.Fatalf("n2 got %d, want 5", got)
	}
	h.audit()
}

// TestNodeAckLossMakesHole: 号码发出前应答丢失 -> 空洞, 但绝不重发。
func TestNodeAckLossMakesHole(t *testing.T) {
	h := newHarness(t)
	n1 := h.openOrRestart("n1")
	if got, _ := h.issue(n1, 5); got != 1 {
		t.Fatalf("got %d, want 1", got)
	}
	st0, _ := n1.State()

	h.f.Enable(numalloc.FaultNodeAck)
	if _, err := n1.Next(); !errors.Is(err, numalloc.ErrAckLost) {
		t.Fatalf("want ErrAckLost, got %v", err)
	}
	h.f.Disable(numalloc.FaultNodeAck)

	st1, _ := n1.State()
	if st1.Cursor != st0.Cursor+1 {
		t.Fatalf("cursor %d -> %d, want +1 (hole)", st0.Cursor, st1.Cursor)
	}
	// 空洞号码 st0.Cursor 被跳过, 下一个号码是 st0.Cursor+1。
	if got, _ := h.issue(n1, 5); got != st0.Cursor+1 {
		t.Fatalf("got %d, want %d (hole at %d)", got, st0.Cursor+1, st0.Cursor)
	}
	h.audit()
}

// TestWriteFaultCrashRecovery: 落盘失败 -> fail-stop, 恢复后不重复发号。
func TestWriteFaultCrashRecovery(t *testing.T) {
	h := newHarness(t)
	n1 := h.openOrRestart("n1")
	if got, _ := h.issue(n1, 5); got != 1 {
		t.Fatalf("got %d, want 1", got)
	}

	// 节点状态落盘失败: 号码未发出, 重试拿到同一个。
	h.f.Enable(numalloc.FaultNodeWrite)
	if _, err := n1.Next(); !errors.Is(err, numalloc.ErrPersist) {
		t.Fatalf("want ErrPersist, got %v", err)
	}
	h.f.Disable(numalloc.FaultNodeWrite)
	if got, _ := h.issue(n1, 5); got != 2 {
		t.Fatalf("got %d, want 2 (failed write must not consume)", got)
	}

	// 分配器落盘失败: 进入 fail-stop, Reopen 后状态未前进。
	n2 := h.openOrRestart("n2")
	h.f.Enable(numalloc.FaultAllocWrite)
	if err := n2.EnsureRange(5, "w1"); !errors.Is(err, numalloc.ErrBroken) {
		t.Fatalf("want ErrBroken, got %v", err)
	}
	h.f.Disable(numalloc.FaultAllocWrite)
	h.reopenAllocator()
	if err := n2.EnsureRange(5, "w1"); err != nil {
		t.Fatalf("ensure after reopen: %v", err)
	}
	if got, _ := h.issue(n2, 5); got != 6 {
		t.Fatalf("n2 got %d, want 6 (crashed alloc must not advance)", got)
	}
	h.audit()
}

// TestChaos: 随机故障注入 + 重启 + 转让, 最终核对全历史编号唯一。
func TestChaos(t *testing.T) {
	for _, seed := range []int64{1, 2, 3} {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			h := newHarness(t)
			rng := rand.New(rand.NewSource(seed))
			faultPoints := []string{
				numalloc.FaultAllocWrite, numalloc.FaultAllocAck,
				numalloc.FaultCloseAck, numalloc.FaultGrantAck,
				numalloc.FaultNodeWrite, numalloc.FaultNodeAck,
			}
			var ids []string
			for i := 0; i < 3; i++ {
				id := fmt.Sprintf("n%d", i)
				h.openOrRestart(id)
				ids = append(ids, id)
			}

			for i := 0; i < 500; i++ {
				h.f.Clear()
				if rng.Float64() < 0.35 {
					h.f.Enable(faultPoints[rng.Intn(len(faultPoints))])
				}
				switch rng.Intn(10) {
				case 0, 1: // 重启随机节点
					id := ids[rng.Intn(len(ids))]
					h.openOrRestart(id)
				case 2: // 转让到全新节点
					from := h.nodes[ids[rng.Intn(len(ids))]]
					id := fmt.Sprintf("n%d", len(ids))
					to := h.openOrRestart(id)
					ids = append(ids, id)
					h.ensure(from, 8)
					reqID := h.reqID()
					for {
						err := numalloc.Transfer(from, to, reqID)
						if err == nil || errors.Is(err, numalloc.ErrNoLease) ||
							errors.Is(err, numalloc.ErrClosed) {
							break
						}
						if errors.Is(err, numalloc.ErrBroken) {
							h.f.Clear()
							h.reopenAllocator()
							continue
						}
						if errors.Is(err, numalloc.ErrAckLost) || errors.Is(err, numalloc.ErrPersist) {
							h.f.Clear()
							continue
						}
						t.Fatalf("transfer: %v", err)
					}
				case 3: // 模拟分配器崩溃重启
					h.reopenAllocator()
				default: // 发号
					id := ids[rng.Intn(len(ids))]
					h.issue(h.nodes[id], 8)
				}
			}
			h.f.Clear()
			spans := h.audit()
			t.Logf("ops done: nodes=%d leases=%d issued=%d", len(ids), len(spans), len(h.issued))
		})
	}
}

// TestConcurrentIssue: 多 goroutine 并发发号, 核对唯一性。
func TestConcurrentIssue(t *testing.T) {
	h := newHarness(t)
	var wg sync.WaitGroup
	for g := 0; g < 3; g++ {
		id := fmt.Sprintf("w%d", g)
		n := h.openOrRestart(id)
		for k := 0; k < 3; k++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for i := 0; i < 100; i++ {
					h.issue(n, 25)
				}
			}()
		}
	}
	wg.Wait()
	spans := h.audit()
	if len(h.issued) != 900 {
		t.Fatalf("issued %d numbers, want 900", len(h.issued))
	}
	t.Logf("leases=%d issued=%d", len(spans), len(h.issued))
}
