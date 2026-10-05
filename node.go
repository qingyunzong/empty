package numalloc

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// NodeState 是节点的持久化状态。
type NodeState struct {
	NodeID   string `json:"node_id"`
	HasLease bool   `json:"has_lease"`
	Closed   bool   `json:"closed"` // 旧代已被 fencing, 禁止再发号
	Gen      uint64 `json:"gen"`
	Lo       int64  `json:"lo"`
	Hi       int64  `json:"hi"`
	Cursor   int64  `json:"cursor"` // 第一个未消费号码
}

// stateLocks 按状态文件路径串行化"读-改-写", 防止发号与 fencing 交错。
var stateLocks sync.Map // path -> *sync.Mutex

func stateLock(path string) *sync.Mutex {
	l, _ := stateLocks.LoadOrStore(path, &sync.Mutex{})
	return l.(*sync.Mutex)
}

// Node 是持有区间租约的发号节点。发号前先把游标落盘,
// 因此重启后只会续用未消费尾部, 绝不重发已消费号码。
type Node struct {
	id     string
	path   string
	alloc  *Allocator
	faults *Faults
}

// OpenNode 打开(或创建)节点。重复打开同一目录即模拟重启。
func OpenNode(dir, id string, alloc *Allocator, faults *Faults) (*Node, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	n := &Node{id: id, path: filepath.Join(dir, "state.json"), alloc: alloc, faults: faults}
	mu := stateLock(n.path)
	mu.Lock()
	defer mu.Unlock()
	if _, err := os.Stat(n.path); errors.Is(err, os.ErrNotExist) {
		if err := n.persistLocked(NodeState{NodeID: id}); err != nil {
			return nil, err
		}
	} else if err == nil {
		st, err := n.loadLocked()
		if err != nil {
			return nil, err
		}
		if st.NodeID != id {
			return nil, fmt.Errorf("numalloc: state file belongs to node %q, not %q", st.NodeID, id)
		}
	} else {
		return nil, err
	}
	return n, nil
}

func (n *Node) ID() string { return n.id }

// State 返回节点当前持久化状态的快照。
func (n *Node) State() (NodeState, error) {
	mu := stateLock(n.path)
	mu.Lock()
	defer mu.Unlock()
	return n.loadLocked()
}

func (n *Node) loadLocked() (NodeState, error) {
	b, err := os.ReadFile(n.path)
	if err != nil {
		return NodeState{}, err
	}
	var st NodeState
	if err := json.Unmarshal(b, &st); err != nil {
		return NodeState{}, err
	}
	return st, nil
}

func (n *Node) persistLocked(st NodeState) error {
	if n.faults.injected(FaultNodeWrite) {
		return fmt.Errorf("%w: injected node write fault", ErrPersist)
	}
	if err := writeFileAtomic(n.path, st); err != nil {
		return fmt.Errorf("%w: %v", ErrPersist, err)
	}
	return nil
}

// EnsureRange 确保节点持有未耗尽的区间, 不足时先关闭旧租约再申请新租约。
// 用相同 reqID 重试是幂等的。
func (n *Node) EnsureRange(size int64, reqID string) error {
	mu := stateLock(n.path)
	mu.Lock()
	defer mu.Unlock()
	st, err := n.loadLocked()
	if err != nil {
		return err
	}
	if st.Closed {
		return ErrClosed
	}
	if st.HasLease && st.Cursor <= st.Hi {
		return nil
	}
	if st.HasLease {
		// 旧区间已耗尽: 先在分配器关闭, 再申请新区间。
		if _, err := n.alloc.CloseLease(n.id, st.Cursor, reqID+":close"); err != nil {
			return err
		}
	}
	lease, err := n.alloc.Allocate(n.id, size, reqID+":alloc")
	if err != nil {
		return err
	}
	return n.persistLocked(NodeState{
		NodeID: n.id, HasLease: true,
		Gen: lease.Gen, Lo: lease.Lo, Hi: lease.Hi, Cursor: lease.Lo,
	})
}

// Next 发出下一个号码。游标先落盘再返回, 因此:
//   - 落盘失败: 号码未发出, 重试会拿到同一个号码, 不会重复;
//   - 落盘成功但应答丢失(FaultNodeAck): 该号码成为空洞, 绝不重发。
func (n *Node) Next() (int64, error) {
	mu := stateLock(n.path)
	mu.Lock()
	defer mu.Unlock()
	st, err := n.loadLocked()
	if err != nil {
		return 0, err
	}
	if st.Closed {
		return 0, ErrClosed
	}
	if !st.HasLease {
		return 0, ErrNoLease
	}
	if st.Cursor > st.Hi {
		return 0, ErrExhausted
	}
	num := st.Cursor
	st.Cursor++
	if err := n.persistLocked(st); err != nil {
		return 0, err
	}
	if n.faults.injected(FaultNodeAck) {
		return 0, ErrAckLost
	}
	return num, nil
}
