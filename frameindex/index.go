package frameindex

import (
	"fmt"
	"sort"
)

// Index 是帧索引库，按 ID 存储帧记录。
type Index struct {
	frames map[string]Frame
}

// NewIndex 创建空索引。
func NewIndex() *Index {
	return &Index{frames: make(map[string]Frame)}
}

// Add 录入一帧。重复 ID 或空 ID 报错。
func (ix *Index) Add(f Frame) error {
	if f.ID == "" {
		return fmt.Errorf("frameindex: empty frame ID")
	}
	if _, dup := ix.frames[f.ID]; dup {
		return fmt.Errorf("frameindex: duplicate frame ID %q", f.ID)
	}
	refs := make([]string, len(f.Refs))
	copy(refs, f.Refs)
	f.Refs = refs
	ix.frames[f.ID] = f
	return nil
}

// Get 按 ID 取帧。
func (ix *Index) Get(id string) (Frame, bool) {
	f, ok := ix.frames[id]
	return f, ok
}

// Len 返回帧数。
func (ix *Index) Len() int { return len(ix.frames) }

// Frames 返回全部帧的副本（顺序未定）。
func (ix *Index) Frames() []Frame {
	out := make([]Frame, 0, len(ix.frames))
	for _, f := range ix.frames {
		out = append(out, f)
	}
	return out
}

// DecodeOrder 返回全图的解码序：严格按 DecodeTime 升序，
// 时间相同按 ID 字典序兜底以保证确定性。
// 注意：这里绝不使用 DisplayTime。
func (ix *Index) DecodeOrder() []Frame {
	out := ix.Frames()
	sort.Slice(out, func(i, j int) bool {
		if out[i].DecodeTime != out[j].DecodeTime {
			return out[i].DecodeTime < out[j].DecodeTime
		}
		return out[i].ID < out[j].ID
	})
	return out
}
