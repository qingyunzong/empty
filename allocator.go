package numalloc

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// 日志记录类型。
const (
	RecAlloc    = "alloc"    // 从全局计数器切出一段新区间
	RecClose    = "close"    // 关闭某节点的当前代, 记录已消费游标
	RecTransfer = "transfer" // 把已关闭区间的未消费尾部授予新节点
)

// Record 是分配器追加日志中的一条记录, 构成全部发号历史。
type Record struct {
	Type   string `json:"type"`
	ReqID  string `json:"req_id"`
	NodeID string `json:"node_id"`
	Gen    uint64 `json:"gen"`
	Lo     int64  `json:"lo"`
	Hi     int64  `json:"hi"`
	Cursor int64  `json:"cursor,omitempty"` // 仅 close: 第一个未消费号码
}

// Lease 是授予某节点的一段整数区间 [Lo, Hi]。
type Lease struct {
	NodeID string
	Gen    uint64
	Lo     int64
	Hi     int64
}

var (
	// ErrBroken 表示存储层发生崩溃(如落盘失败), 必须 Reopen 后才能继续。
	ErrBroken = errors.New("numalloc: store crashed, reopen required")
	// ErrAckLost 表示操作已持久化提交, 但应答丢失; 用相同 reqID 重试即可拿到原结果。
	ErrAckLost = errors.New("numalloc: committed but acknowledgement lost")
	// ErrClosed 表示该代区间已被关闭(转让或退役), 禁止再发号。
	ErrClosed = errors.New("numalloc: lease generation is closed")
	// ErrExhausted 表示当前区间已消费完。
	ErrExhausted = errors.New("numalloc: range exhausted")
	// ErrNoLease 表示节点没有可用区间。
	ErrNoLease = errors.New("numalloc: node holds no active lease")
	// ErrPersist 表示节点状态落盘失败; 重试安全(未提交任何变更)。
	ErrPersist = errors.New("numalloc: state persist failed")
)

// Allocator 持久化地向节点分配互不重叠的整数区间。
// 所有状态变更先追加日志并 fsync, 再更新内存; 落盘失败即进入
// fail-stop 状态(ErrBroken), 杜绝崩溃后重复发号, 但允许空洞。
type Allocator struct {
	mu     sync.Mutex
	path   string
	faults *Faults

	file   *os.File
	broken bool

	next   int64             // 下一个未分配号码
	gen    uint64            // 全局单调递增代号
	reqs   map[string]Record // 已提交请求 -> 结果, 用于幂等重放
	active map[string]Lease  // 节点 -> 当前活跃租约
	hist   []Record          // 全量历史, 供审计
}

// OpenAllocator 打开(或创建)位于 dir 的分配器, 并重放日志恢复状态。
func OpenAllocator(dir string, faults *Faults) (*Allocator, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	a := &Allocator{
		path:   filepath.Join(dir, "allocator.log"),
		faults: faults,
	}
	if err := a.recover(); err != nil {
		return nil, err
	}
	return a, nil
}

func (a *Allocator) recover() error {
	f, err := os.OpenFile(a.path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return err
	}
	a.reqs = make(map[string]Record)
	a.active = make(map[string]Lease)
	a.hist = nil
	a.next = 1
	a.gen = 0

	var offset int64
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for sc.Scan() {
		line := sc.Bytes()
		offset += int64(len(line)) + 1
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var r Record
		if err := json.Unmarshal(line, &r); err != nil {
			// 尾部撕裂写: 截断到最后一条完整记录。
			if terr := f.Truncate(offset - int64(len(line)) - 1); terr != nil {
				f.Close()
				return terr
			}
			break
		}
		a.apply(r)
	}
	if err := sc.Err(); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Seek(0, io.SeekEnd); err != nil {
		f.Close()
		return err
	}
	a.file = f
	a.broken = false
	return nil
}

func (a *Allocator) apply(r Record) {
	a.hist = append(a.hist, r)
	if r.ReqID != "" {
		a.reqs[r.ReqID] = r
	}
	if r.Gen > a.gen {
		a.gen = r.Gen
	}
	switch r.Type {
	case RecAlloc:
		a.active[r.NodeID] = Lease{NodeID: r.NodeID, Gen: r.Gen, Lo: r.Lo, Hi: r.Hi}
		if r.Hi >= a.next {
			a.next = r.Hi + 1
		}
	case RecClose:
		delete(a.active, r.NodeID)
	case RecTransfer:
		a.active[r.NodeID] = Lease{NodeID: r.NodeID, Gen: r.Gen, Lo: r.Lo, Hi: r.Hi}
	}
}

// appendLog 持久化一条记录。注入 FaultAllocWrite 或真实 I/O 错误时
// 不写入任何内容并进入 fail-stop 状态, 保证重启后不会重复发号。
func (a *Allocator) appendLog(r Record) error {
	if a.faults.injected(FaultAllocWrite) {
		a.broken = true
		return ErrBroken
	}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	if _, err := a.file.Write(append(b, '\n')); err != nil {
		a.broken = true
		return err
	}
	if err := a.file.Sync(); err != nil {
		a.broken = true
		return err
	}
	return nil
}

// Reopen 在崩溃(ErrBroken)后重新从磁盘恢复。
func (a *Allocator) Reopen() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.file != nil {
		a.file.Close()
		a.file = nil
	}
	return a.recover()
}

// Close 关闭日志文件句柄。
func (a *Allocator) Close() error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.file != nil {
		err := a.file.Close()
		a.file = nil
		return err
	}
	return nil
}

// replay 检查 reqID 是否已提交过; 是则返回原记录(幂等重放)。
func (a *Allocator) replay(reqID, wantType string) (Record, bool, error) {
	r, ok := a.reqs[reqID]
	if !ok {
		return Record{}, false, nil
	}
	if r.Type != wantType {
		return Record{}, false, fmt.Errorf("numalloc: reqID %q reused for a different operation", reqID)
	}
	return r, true, nil
}

// Allocate 从全局计数器切出 [next, next+size-1] 授予 nodeID。
// 同一 reqID 重试返回原租约, 不会重复扣减计数器。
func (a *Allocator) Allocate(nodeID string, size int64, reqID string) (Lease, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.broken {
		return Lease{}, ErrBroken
	}
	if size <= 0 {
		return Lease{}, fmt.Errorf("numalloc: invalid range size %d", size)
	}
	if r, ok, err := a.replay(reqID, RecAlloc); err != nil {
		return Lease{}, err
	} else if ok {
		if a.faults.injected(FaultAllocAck) {
			return Lease{}, ErrAckLost
		}
		return Lease{NodeID: r.NodeID, Gen: r.Gen, Lo: r.Lo, Hi: r.Hi}, nil
	}
	if _, ok := a.active[nodeID]; ok {
		return Lease{}, fmt.Errorf("numalloc: node %q already holds an active lease", nodeID)
	}
	r := Record{Type: RecAlloc, ReqID: reqID, NodeID: nodeID, Gen: a.gen + 1, Lo: a.next, Hi: a.next + size - 1}
	if err := a.appendLog(r); err != nil {
		return Lease{}, err
	}
	a.apply(r)
	if a.faults.injected(FaultAllocAck) {
		return Lease{}, ErrAckLost
	}
	return Lease{NodeID: nodeID, Gen: r.Gen, Lo: r.Lo, Hi: r.Hi}, nil
}

// CloseLease 关闭 nodeID 的当前代, cursor 为该节点持久化的已消费游标。
// 关闭后 [cursor, Hi] 成为可转让的未消费尾部。
func (a *Allocator) CloseLease(nodeID string, cursor int64, reqID string) (Record, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.broken {
		return Record{}, ErrBroken
	}
	if r, ok, err := a.replay(reqID, RecClose); err != nil {
		return Record{}, err
	} else if ok {
		if a.faults.injected(FaultCloseAck) {
			return Record{}, ErrAckLost
		}
		return r, nil
	}
	l, ok := a.active[nodeID]
	if !ok {
		return Record{}, ErrNoLease
	}
	if cursor < l.Lo || cursor > l.Hi+1 {
		return Record{}, fmt.Errorf("numalloc: cursor %d outside lease [%d,%d]", cursor, l.Lo, l.Hi)
	}
	r := Record{Type: RecClose, ReqID: reqID, NodeID: nodeID, Gen: l.Gen, Lo: l.Lo, Hi: l.Hi, Cursor: cursor}
	if err := a.appendLog(r); err != nil {
		return Record{}, err
	}
	a.apply(r)
	if a.faults.injected(FaultCloseAck) {
		return Record{}, ErrAckLost
	}
	return r, nil
}

// GrantTransfer 把 fromID 已关闭区间的尾部 [lo, hi] 以新代授予 toID。
// 强制要求旧代已先在日志中关闭, 且授予区间必须与关闭记录一致。
func (a *Allocator) GrantTransfer(toID, fromID string, lo, hi int64, reqID string) (Lease, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.broken {
		return Lease{}, ErrBroken
	}
	if r, ok, err := a.replay(reqID, RecTransfer); err != nil {
		return Lease{}, err
	} else if ok {
		if a.faults.injected(FaultGrantAck) {
			return Lease{}, ErrAckLost
		}
		return Lease{NodeID: r.NodeID, Gen: r.Gen, Lo: r.Lo, Hi: r.Hi}, nil
	}
	if lo > hi {
		return Lease{}, fmt.Errorf("numalloc: empty transfer range [%d,%d]", lo, hi)
	}
	if _, ok := a.active[toID]; ok {
		return Lease{}, fmt.Errorf("numalloc: target node %q already holds an active lease", toID)
	}
	if _, ok := a.active[fromID]; ok {
		return Lease{}, fmt.Errorf("numalloc: source generation of %q still active, close it first", fromID)
	}
	// 找到 fromID 最后一次关闭记录, 校验尾部一致。
	var closed *Record
	for i := len(a.hist) - 1; i >= 0; i-- {
		if a.hist[i].Type == RecClose && a.hist[i].NodeID == fromID {
			closed = &a.hist[i]
			break
		}
	}
	if closed == nil || closed.Cursor != lo || closed.Hi != hi {
		return Lease{}, fmt.Errorf("numalloc: transfer range [%d,%d] does not match the closed tail of %q", lo, hi, fromID)
	}
	r := Record{Type: RecTransfer, ReqID: reqID, NodeID: toID, Gen: a.gen + 1, Lo: lo, Hi: hi}
	if err := a.appendLog(r); err != nil {
		return Lease{}, err
	}
	a.apply(r)
	if a.faults.injected(FaultGrantAck) {
		return Lease{}, ErrAckLost
	}
	return Lease{NodeID: toID, Gen: r.Gen, Lo: r.Lo, Hi: r.Hi}, nil
}

// History 返回全量已提交记录(按提交顺序), 供审计核对。
func (a *Allocator) History() []Record {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]Record(nil), a.hist...)
}
