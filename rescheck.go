// Package rescheck 是一个资源检查库：跟踪句柄的创建、子句柄共享与释放。
//
// 语义：
//   - 句柄通过 Tracker.Root 创建根句柄，通过 Handle.Child 派生子句柄，构成树状所有权图。
//   - 每个句柄占用一个槽位，槽位携带单调递增的代际号；槽位复用时代际号递增，
//     使持有旧代际号的句柄（stale handle）被识别并拒绝（防 ABA 重用）。
//   - 父块仅当其自身已释放且全部子句柄（引用）都已释放时才被回收，回收沿树向上级联。
//   - 句柄释放（关闭）后不允许再创建子句柄。
//   - Tracker.Leaks / Tracker.Close 输出泄漏句柄的所有者路径（含代际号，如 db#1/conn#2）。
package rescheck

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
)

var (
	// ErrClosed 表示在已释放（关闭）的句柄上创建子句柄。
	ErrClosed = errors.New("rescheck: 句柄已关闭，不允许再创建子句柄")
	// ErrDoubleRelease 表示同一代际的句柄被重复释放。
	ErrDoubleRelease = errors.New("rescheck: 句柄被重复释放")
	// ErrStale 表示句柄的槽位已被更新代际重用，旧句柄失效。
	ErrStale = errors.New("rescheck: 失效句柄（槽位已被新代际重用）")
	// ErrDone 表示 Tracker 已关闭，不允许再创建句柄。
	ErrDone = errors.New("rescheck: 跟踪器已关闭")
)

// LeakError 在 Tracker.Close 发现未释放句柄时返回，Paths 为泄漏句柄的所有者路径。
type LeakError struct {
	Paths []string
}

func (e *LeakError) Error() string {
	return fmt.Sprintf("rescheck: 检测到 %d 个泄漏句柄: %s", len(e.Paths), strings.Join(e.Paths, ", "))
}

// slot 是句柄的底层记录。块被回收的条件：!open && children == 0。
type slot struct {
	gen      uint64 // 代际号，槽位每次复用时递增
	open     bool   // 句柄自身尚未释放
	children int    // 存活的子句柄数（含未回收的后代链）
	parent   int    // 父槽位下标，根为 -1
	path     string // 所有者路径，各段带代际号，如 db#1/conn#2
}

// Tracker 跟踪一组句柄的生命周期。并发安全。
type Tracker struct {
	mu    sync.Mutex
	slots []slot
	free  []int // 已回收、可复用的槽位（LIFO）
	done  bool
}

// New 创建一个空的 Tracker。
func New() *Tracker { return &Tracker{} }

// Handle 是某个槽位特定代际的句柄。句柄为值类型，可复制；
// 对同一（槽位, 代际）的重复释放会被检测为 ErrDoubleRelease。
type Handle struct {
	t    *Tracker
	slot int
	gen  uint64
}

// Root 创建一个根句柄。
func (t *Tracker) Root(name string) (*Handle, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.done {
		return nil, ErrDone
	}
	idx := t.alloc(name, -1)
	return &Handle{t: t, slot: idx, gen: t.slots[idx].gen}, nil
}

// alloc 分配（或复用）一个槽位，代际号递增，并登记到父槽位。
func (t *Tracker) alloc(name string, parent int) int {
	var idx int
	if n := len(t.free); n > 0 {
		idx = t.free[n-1]
		t.free = t.free[:n-1]
	} else {
		idx = len(t.slots)
		t.slots = append(t.slots, slot{})
	}
	s := &t.slots[idx]
	s.gen++
	s.open = true
	s.children = 0
	s.parent = parent
	if parent >= 0 {
		s.path = t.slots[parent].path + "/" + name
		t.slots[parent].children++
	} else {
		s.path = name
	}
	s.path = fmt.Sprintf("%s#%d", s.path, s.gen)
	return idx
}

// lookup 校验句柄的槽位与代际是否仍然有效。
func (t *Tracker) lookup(h *Handle) (*slot, error) {
	if h == nil || h.t != t || h.slot < 0 || h.slot >= len(t.slots) {
		return nil, ErrStale
	}
	s := &t.slots[h.slot]
	if s.gen != h.gen {
		return nil, ErrStale
	}
	return s, nil
}

// Child 在句柄下创建一个子句柄（共享父块，父块引用计数 +1）。
// 父句柄已关闭时返回 ErrClosed；句柄失效时返回 ErrStale。
func (h *Handle) Child(name string) (*Handle, error) {
	t := h.t
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.done {
		return nil, ErrDone
	}
	s, err := t.lookup(h)
	if err != nil {
		return nil, err
	}
	if !s.open {
		return nil, ErrClosed
	}
	idx := t.alloc(name, h.slot)
	return &Handle{t: t, slot: idx, gen: t.slots[idx].gen}, nil
}

// Release 释放（关闭）句柄。父块在全部引用释放前不会被回收。
// 重复释放返回 ErrDoubleRelease；句柄失效返回 ErrStale。
func (h *Handle) Release() error {
	t := h.t
	t.mu.Lock()
	defer t.mu.Unlock()
	s, err := t.lookup(h)
	if err != nil {
		return err
	}
	if !s.open {
		return ErrDoubleRelease
	}
	s.open = false
	t.reclaim(h.slot)
	return nil
}

// reclaim 回收满足条件的槽位，并沿父链向上级联。
func (t *Tracker) reclaim(idx int) {
	for idx >= 0 {
		s := &t.slots[idx]
		if s.open || s.children > 0 {
			return
		}
		parent := s.parent
		t.free = append(t.free, idx)
		if parent >= 0 {
			t.slots[parent].children--
		}
		idx = parent
	}
}

// Path 返回句柄的所有者路径（含代际号），如 db#1/conn#2。
func (h *Handle) Path() string {
	t := h.t
	t.mu.Lock()
	defer t.mu.Unlock()
	if h.slot < 0 || h.slot >= len(t.slots) {
		return ""
	}
	return t.slots[h.slot].path
}

// Generation 返回句柄的代际号；同一槽位被复用时新句柄的代际号递增。
func (h *Handle) Generation() uint64 { return h.gen }

// Leaks 返回当前所有未释放句柄的所有者路径（按字典序）。
func (t *Tracker) Leaks() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []string
	for i := range t.slots {
		if t.slots[i].open {
			out = append(out, t.slots[i].path)
		}
	}
	sort.Strings(out)
	return out
}

// SlotsInUse 返回仍在使用（未回收）的槽位数，用于验证父块回收时机。
func (t *Tracker) SlotsInUse() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.slots) - len(t.free)
}

// Close 关闭跟踪器。若仍有未释放的句柄，返回 *LeakError，其 Paths 为泄漏所有者路径。
func (t *Tracker) Close() error {
	t.mu.Lock()
	t.done = true
	t.mu.Unlock()
	if leaks := t.Leaks(); len(leaks) > 0 {
		return &LeakError{Paths: leaks}
	}
	return nil
}
