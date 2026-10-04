package mirror

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	// BlockSize 是定长块大小（字节）。
	BlockSize = 1024
	// Fanout 是哈希树每个内部节点的子节点数。
	Fanout = 16
)

// Hash 是 SHA-256 摘要。
type Hash [32]byte

// ErrVersionConflict 表示修复读取期间源版本发生变化，
// 本次修复不会发布任何内容，以避免混合两个源版本。
var ErrVersionConflict = errors.New("mirror: source version changed during repair")

// 缺失叶的哈希：与“全零叶”的哈希 leafHashOf(zeros) 明确区分。
var absentLeafHash = sha256.Sum256([]byte{0x01})

// leafHashOf 计算存在叶的哈希，带域分离前缀 0x00。
func leafHashOf(data []byte) Hash {
	h := sha256.New()
	h.Write([]byte{0x00})
	h.Write(data)
	var out Hash
	h.Sum(out[:0])
	return out
}

// internalHash 计算内部节点哈希，带域分离前缀 0x02 与层级。
func internalHash(level uint64, children []Hash) Hash {
	h := sha256.New()
	h.Write([]byte{0x02})
	var lb [8]byte
	binary.LittleEndian.PutUint64(lb[:], level)
	h.Write(lb[:])
	for i := range children {
		h.Write(children[i][:])
	}
	var out Hash
	h.Sum(out[:0])
	return out
}

// emptySubtreeHash 返回某层完全缺失子树的默认哈希，
// 使未存储的节点也有确定值，无需持久化整棵树。
func emptySubtreeHash(level uint64) Hash {
	h := absentLeafHash
	for l := uint64(1); l <= level; l++ {
		var children [Fanout]Hash
		for i := range children {
			children[i] = h
		}
		h = internalHash(l, children[:])
	}
	return h
}

// Tree 是构建在定长块上的 Merkle 哈希树。
// 叶数据存于 blocks，节点哈希存于 nodes；version 在每次写叶时递增，
// 修复过程据此保证不混合两个源版本。
type Tree struct {
	blocks    KV
	nodes     KV
	Leaves    uint64 // 补齐到 Fanout 的幂后的叶位数
	rootLevel uint64
	version   uint64
}

// NewTree 创建一棵容纳 nBlocks 个块的树，叶数补齐到 Fanout 的幂。
func NewTree(blocks, nodes KV, nBlocks uint64) *Tree {
	leaves := uint64(1)
	var rootLevel uint64
	for leaves < nBlocks {
		leaves *= Fanout
		rootLevel++
	}
	return &Tree{blocks: blocks, nodes: nodes, Leaves: leaves, rootLevel: rootLevel}
}

// Build 把数据按定长块切分并建树。
func Build(blocks, nodes KV, data []byte) *Tree {
	n := uint64((len(data) + BlockSize - 1) / BlockSize)
	t := NewTree(blocks, nodes, n)
	for i := uint64(0); i < n; i++ {
		lo := i * BlockSize
		hi := min(lo+BlockSize, uint64(len(data)))
		t.WriteLeaf(i, data[lo:hi])
	}
	return t
}

func blockKey(idx uint64) string       { return fmt.Sprintf("b/%d", idx) }
func nodeKey(level, idx uint64) string { return fmt.Sprintf("n/%d/%d", level, idx) }

// Version 返回当前版本号，每次写叶递增。
func (t *Tree) Version() uint64 { return t.version }

func (t *Tree) getNode(level, idx uint64) Hash {
	raw, err := t.nodes.Get(nodeKey(level, idx))
	if err != nil {
		return emptySubtreeHash(level)
	}
	var h Hash
	copy(h[:], raw)
	return h
}

func (t *Tree) setNode(level, idx uint64, h Hash) {
	t.nodes.Put(nodeKey(level, idx), h[:])
}

// WriteLeaf 写入叶数据并沿路径重算到根。data 为 nil 表示删除该叶（缺失）。
func (t *Tree) WriteLeaf(idx uint64, data []byte) {
	if idx >= t.Leaves {
		panic("mirror: leaf index out of range")
	}
	if len(data) > BlockSize {
		panic("mirror: block larger than BlockSize")
	}
	if data == nil {
		t.blocks.Delete(blockKey(idx))
		t.setNode(0, idx, absentLeafHash)
	} else {
		t.blocks.Put(blockKey(idx), data)
		t.setNode(0, idx, leafHashOf(data))
	}
	pos := idx
	for level := uint64(1); level <= t.rootLevel; level++ {
		parent := pos / Fanout
		var children [Fanout]Hash
		for c := uint64(0); c < Fanout; c++ {
			children[c] = t.getNode(level-1, parent*Fanout+c)
		}
		t.setNode(level, parent, internalHash(level, children[:]))
		pos = parent
	}
	t.version++
}

// ReadLeaf 读取叶数据；缺失时返回 ErrMissing（与全零叶区分）。
func (t *Tree) ReadLeaf(idx uint64) ([]byte, error) {
	if idx >= t.Leaves {
		return nil, fmt.Errorf("mirror: leaf %d out of range", idx)
	}
	return t.blocks.Get(blockKey(idx))
}

// ReadLeafAt 仅在版本号仍等于 version 时读取，否则返回 ErrVersionConflict。
func (t *Tree) ReadLeafAt(version uint64, idx uint64) ([]byte, error) {
	if version != t.version {
		return nil, ErrVersionConflict
	}
	return t.ReadLeaf(idx)
}

// Root 返回根哈希。
func (t *Tree) Root() Hash { return t.getNode(t.rootLevel, 0) }
