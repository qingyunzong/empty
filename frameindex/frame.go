// Package frameindex 提供帧索引库：显式记录每帧的参考帧 ID、解码时间与显示时间，
// 支持按目标显示区间计算最小依赖闭包，并输出拓扑证书。
//
// 核心约束：解码序由 DecodeTime 决定，绝不允许用 DisplayTime 充当解码序。
package frameindex

import "fmt"

// Frame 描述一帧的索引记录。
type Frame struct {
	ID          string   // 帧唯一标识
	DecodeTime  int64    // 解码时间（决定解码序）
	DisplayTime int64    // 显示时间（决定显示区间归属，不参与解码排序）
	Refs        []string // 显式记录的参考帧 ID 列表
}

// MissingRef 记录一条缺失的参考边。
type MissingRef struct {
	From  string // 发起参考的帧
	RefID string // 缺失的参考帧 ID
}

func (m MissingRef) String() string {
	return fmt.Sprintf("frame %q references missing frame %q", m.From, m.RefID)
}

// Cycle 记录依赖图中的一个环（帧 ID 路径，首尾相同）。
type Cycle []string

func (c Cycle) String() string {
	s := ""
	for i, id := range c {
		if i > 0 {
			s += " -> "
		}
		s += id
	}
	return s
}
