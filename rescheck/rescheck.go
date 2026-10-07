// Package rescheck 提供资源句柄的生命周期检查：
// 跟踪句柄创建、子句柄共享与释放；父块在其自身及全部子孙
// 引用释放后才回收；句柄关闭后不允许再创建子句柄；句柄编号
// 可被复用，由代际（generation）区分不同世的句柄；关闭追踪器
// 时输出泄漏句柄的所有者路径。
package rescheck

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

// Handle 是一个资源句柄的不透明标识。
// ID 为槽位编号，可能被复用；Gen 为代际，用于区分复用前后的句柄。
type Handle struct {
	ID  int
	Gen uint64
}

// String 以 "id#gen" 形式呈现，便于日志与泄漏报告阅读。
func (h Handle) String() string { return fmt.Sprintf("%d#%d", h.ID, h.Gen) }

var (
	// ErrTrackerClosed 表示追踪器已关闭，不再接受新根句柄。
	ErrTrackerClosed = errors.New("rescheck: tracker closed")
	// ErrStaleHandle 表示句柄代际不匹配（句柄已释放且编号被复用）。
	ErrStaleHandle = errors.New("rescheck: stale handle (generation mismatch)")
	// ErrUnknownHandle 表示句柄编号超出范围或对应块已回收。
	ErrUnknownHandle = errors.New("rescheck: unknown handle")
	// ErrHandleClosed 表示句柄自身引用已关闭，不允许再创建子句柄。
	ErrHandleClosed = errors.New("rescheck: handle already closed")
)

// node 描述一个资源块及其在句柄树中的位置。
type node struct {
	gen      uint64 // 当前代际，回收时递增
	name     string // 所有者名称，用于泄漏路径
	parent   int    // 父节点槽位，根为 -1
	open     bool   // 自身引用是否仍被持有
	children int    // 存活（未回收）子块数量
	alive    bool   // 块是否尚未回收
}

// Tracker 跟踪一组句柄的创建、共享与释放。并发安全。
type Tracker struct {
	mu     sync.Mutex
	nodes  []node
	free   []int // 可复用的槽位编号
	closed bool
}

// NewTracker 创建一个空的追踪器。
func NewTracker() *Tracker { return &Tracker{} }

// Open 创建一个根句柄（无父块）。
func (t *Tracker) Open(name string) (Handle, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.closed {
		return Handle{}, ErrTrackerClosed
	}
	return t.allocLocked(-1, name), nil
}

// Child 在 parent 下创建一个子句柄，子句柄共享父块的生命周期：
// 父块只有在自身引用与全部子孙引用都释放后才会被回收。
// parent 已关闭或已失效（代际不匹配）时返回错误。
func (t *Tracker) Child(parent Handle, name string) (Handle, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	pn, err := t.lookupLocked(parent)
	if err != nil {
		return Handle{}, err
	}
	if !pn.open {
		return Handle{}, fmt.Errorf("%w: cannot create child %q on closed handle %s", ErrHandleClosed, name, parent)
	}
	h := t.allocLocked(parent.ID, name)
	t.nodes[parent.ID].children++
	return h, nil
}

// Close 释放句柄自身的引用。若该块的全部子孙引用也已释放，
// 块被回收并可能级联触发祖先块回收。重复关闭或使用失效句柄返回错误。
func (t *Tracker) Close(h Handle) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	n, err := t.lookupLocked(h)
	if err != nil {
		return err
	}
	if !n.open {
		return fmt.Errorf("%w: double close of %s", ErrHandleClosed, h)
	}
	n.open = false
	t.reclaimLocked(h.ID)
	return nil
}

// lookupLocked 校验句柄：编号合法、块未回收、代际一致。
func (t *Tracker) lookupLocked(h Handle) (*node, error) {
	if h.ID < 0 || h.ID >= len(t.nodes) {
		return nil, fmt.Errorf("%w: %s", ErrUnknownHandle, h)
	}
	n := &t.nodes[h.ID]
	if !n.alive {
		if n.gen == h.Gen {
			return nil, fmt.Errorf("%w: %s (block reclaimed)", ErrHandleClosed, h)
		}
		return nil, fmt.Errorf("%w: have %s, slot is at generation %d", ErrStaleHandle, h, n.gen)
	}
	if n.gen != h.Gen {
		return nil, fmt.Errorf("%w: have %s, slot is at generation %d", ErrStaleHandle, h, n.gen)
	}
	return n, nil
}

// allocLocked 分配一个槽位（优先复用已回收编号）并初始化节点。
func (t *Tracker) allocLocked(parent int, name string) Handle {
	if n := len(t.free); n > 0 {
		id := t.free[n-1]
		t.free = t.free[:n-1]
		slot := &t.nodes[id]
		slot.gen++ // 复用编号时递增代际，使旧句柄失效
		slot.name = name
		slot.parent = parent
		slot.open = true
		slot.children = 0
		slot.alive = true
		return Handle{ID: id, Gen: slot.gen}
	}
	t.nodes = append(t.nodes, node{
		gen:    1,
		name:   name,
		parent: parent,
		open:   true,
		alive:  true,
	})
	return Handle{ID: len(t.nodes) - 1, Gen: 1}
}

// reclaimLocked 在节点自身引用释放后尝试回收其块：
// 仅当自身引用与全部子块引用均释放时才回收；回收会向上级联。
// 代际在槽位复用时才递增，因此回收后旧句柄仍能被识别为"已关闭"。
func (t *Tracker) reclaimLocked(id int) {
	for id >= 0 {
		n := &t.nodes[id]
		if n.open || n.children > 0 || !n.alive {
			return
		}
		n.alive = false
		t.free = append(t.free, id)
		id = n.parent
		if id >= 0 {
			t.nodes[id].children--
		}
	}
}

// Leaks 返回所有仍被持有（自身引用未释放）的句柄的所有者路径，
// 路径形如 "db/conn#2/tx#5"，每段为 "名称(编号#代际)" 的简写。
// 路径按字典序排序，输出稳定。
func (t *Tracker) Leaks() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var leaks []string
	for id := range t.nodes {
		if t.nodes[id].alive && t.nodes[id].open {
			leaks = append(leaks, t.pathLocked(id))
		}
	}
	sortStrings(leaks)
	return leaks
}

// pathLocked 构造从根到 id 的所有者路径。
func (t *Tracker) pathLocked(id int) string {
	var segs []string
	for cur := id; cur >= 0; cur = t.nodes[cur].parent {
		n := &t.nodes[cur]
		segs = append(segs, fmt.Sprintf("%s(%d#%d)", n.name, cur, n.gen))
	}
	var sb strings.Builder
	for i := len(segs) - 1; i >= 0; i-- {
		if i != len(segs)-1 {
			sb.WriteByte('/')
		}
		sb.WriteString(segs[i])
	}
	return sb.String()
}

// LiveBlocks 返回尚未回收的块数量（含自身引用已释放但子孙仍存活的块）。
// 主要用于测试与诊断。
func (t *Tracker) LiveBlocks() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	count := 0
	for i := range t.nodes {
		if t.nodes[i].alive {
			count++
		}
	}
	return count
}

// CloseTracker 关闭追踪器：之后不允许再创建根句柄。
// 若仍有未释放的句柄，返回包含全部泄漏所有者路径的错误；否则返回 nil。
func (t *Tracker) CloseTracker() error {
	t.mu.Lock()
	t.closed = true
	t.mu.Unlock()
	leaks := t.Leaks()
	if len(leaks) == 0 {
		return nil
	}
	return fmt.Errorf("rescheck: %d leaked handle(s):\n  %s", len(leaks), strings.Join(leaks, "\n  "))
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
