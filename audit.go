package numalloc

import (
	"fmt"
	"sort"
)

// LeaseSpan 描述一段被授予的租约及其已消费部分 [Lo, Cursor-1]。
type LeaseSpan struct {
	NodeID string
	Gen    uint64
	Lo     int64
	Hi     int64
	Cursor int64 // 第一个未消费号码
}

// Audit 重放全量历史, 核对"全历史编号唯一":
// 所有租约的已消费区间两两不重叠。activeCursors 提供日志中仍未关闭的
// 租约对应的节点持久化游标(从各节点状态文件读取); 多余的键会被忽略。
// 返回全部租约的消费区间, 或发现重叠/不一致时的错误。
func (a *Allocator) Audit(activeCursors map[string]int64) ([]LeaseSpan, error) {
	a.mu.Lock()
	defer a.mu.Unlock()

	var spans []LeaseSpan
	open := make(map[string]int) // nodeID -> spans 下标
	for _, r := range a.hist {
		switch r.Type {
		case RecAlloc, RecTransfer:
			if _, dup := open[r.NodeID]; dup {
				return nil, fmt.Errorf("numalloc: node %q granted a new lease while the previous one is still open", r.NodeID)
			}
			spans = append(spans, LeaseSpan{NodeID: r.NodeID, Gen: r.Gen, Lo: r.Lo, Hi: r.Hi, Cursor: r.Lo})
			open[r.NodeID] = len(spans) - 1
		case RecClose:
			idx, ok := open[r.NodeID]
			if !ok {
				return nil, fmt.Errorf("numalloc: close without an open lease for node %q", r.NodeID)
			}
			spans[idx].Cursor = r.Cursor
			delete(open, r.NodeID)
		}
	}
	for nodeID, idx := range open {
		cursor, ok := activeCursors[nodeID]
		if !ok {
			return nil, fmt.Errorf("numalloc: missing durable cursor for active lease of node %q", nodeID)
		}
		spans[idx].Cursor = cursor
	}

	for _, s := range spans {
		if s.Cursor < s.Lo || s.Cursor > s.Hi+1 {
			return nil, fmt.Errorf("numalloc: cursor %d outside lease [%d,%d] of node %q", s.Cursor, s.Lo, s.Hi, s.NodeID)
		}
	}

	sorted := append([]LeaseSpan(nil), spans...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Lo < sorted[j].Lo })
	prevHi := int64(-1)
	for _, s := range sorted {
		if s.Cursor <= s.Lo {
			continue // 未消费任何号码
		}
		if s.Lo <= prevHi {
			return nil, fmt.Errorf("numalloc: duplicate numbers detected: consumed [%d,%d] of node %q overlaps an earlier interval", s.Lo, s.Cursor-1, s.NodeID)
		}
		prevHi = s.Cursor - 1
	}
	return spans, nil
}
