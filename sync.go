package mirror

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
)

// Diff 比较两棵树的根，仅递归进入哈希不同的子树，
// 返回需要修复的叶索引（升序）。两树叶数不同时退化为全量比较。
func Diff(a, b *Tree) []uint64 {
	if a.Leaves != b.Leaves {
		n := max(a.Leaves, b.Leaves)
		out := make([]uint64, 0, n)
		for i := uint64(0); i < n; i++ {
			out = append(out, i)
		}
		return out
	}
	var out []uint64
	diffNode(a, b, a.rootLevel, 0, &out)
	return out
}

func diffNode(a, b *Tree, level, idx uint64, out *[]uint64) {
	if a.getNode(level, idx) == b.getNode(level, idx) {
		return // 子树一致，不访问其任何子节点
	}
	if level == 0 {
		*out = append(*out, idx)
		return
	}
	for c := uint64(0); c < Fanout; c++ {
		diffNode(a, b, level-1, idx*Fanout+c, out)
	}
}

// Repair 按 Diff 给出的叶列表把 src 的内容发布到 dst。
// 全程先在 src 的固定版本上读取并暂存，全部读完后才一次性发布到 dst；
// 若读取期间源版本变化则返回 ErrVersionConflict，dst 不会被写入，
// 因此一次发布绝不混合两个源版本。源缺失的叶会在 dst 上删除。
func Repair(src, dst *Tree, leaves []uint64) error {
	version := src.Version()
	type stagedWrite struct {
		idx  uint64
		data []byte
	}
	staged := make([]stagedWrite, 0, len(leaves))
	for _, idx := range leaves {
		data, err := src.ReadLeafAt(version, idx)
		switch {
		case errors.Is(err, ErrMissing):
			data = nil
		case err != nil:
			return err
		}
		staged = append(staged, stagedWrite{idx: idx, data: data})
	}
	for _, w := range staged {
		dst.WriteLeaf(w.idx, w.data)
	}
	return nil
}

// Digest 计算全量摘要：顺序遍历全部叶位，存在叶与缺失叶分别编码，
// 用于修复后核对两侧内容完全一致。
func Digest(t *Tree) Hash {
	h := sha256.New()
	var nb [8]byte
	binary.LittleEndian.PutUint64(nb[:], t.Leaves)
	h.Write(nb[:])
	for i := uint64(0); i < t.Leaves; i++ {
		data, err := t.ReadLeaf(i)
		if errors.Is(err, ErrMissing) {
			h.Write([]byte{0x01})
			continue
		}
		h.Write([]byte{0x00})
		h.Write(data)
	}
	var out Hash
	h.Sum(out[:0])
	return out
}
