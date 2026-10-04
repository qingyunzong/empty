package mirror

import (
	"bytes"
	"errors"
	"fmt"
	"math/rand"
	"reflect"
	"testing"
)

func randomBytes(r *rand.Rand, n int) []byte {
	b := make([]byte, n)
	r.Read(b)
	return b
}

// countedTree 用可计数存储器建树，便于核对访问范围。
func countedTree(data []byte) (*Tree, *CountingKV, *CountingKV) {
	blocks := &CountingKV{Inner: NewMemKV()}
	nodes := &CountingKV{Inner: NewMemKV()}
	return Build(blocks, nodes, data), blocks, nodes
}

func cloneCounted(t *Tree, blocks, nodes *CountingKV) (*Tree, *CountingKV, *CountingKV) {
	nb := &CountingKV{Inner: blocks.Inner.(*MemKV).Clone()}
	nn := &CountingKV{Inner: nodes.Inner.(*MemKV).Clone()}
	clone := &Tree{blocks: nb, nodes: nn, Leaves: t.Leaves, rootLevel: t.rootLevel, version: t.version}
	return clone, nb, nn
}

func leafIndices(keys []string) []uint64 {
	var out []uint64
	for _, k := range keys {
		var idx uint64
		if _, err := fmt.Sscanf(k, "b/%d", &idx); err == nil {
			out = append(out, idx)
		}
	}
	return out
}

// 单块损坏时，Diff 只访问不同子树路径上的节点，Repair 只访问损坏叶。
func TestDiffVisitsOnlyDifferingSubtree(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	data := randomBytes(r, 4096*BlockSize)

	src, srcBlocks, srcNodes := countedTree(data)
	dst, dstBlocks, dstNodes := cloneCounted(src, srcBlocks, srcNodes)

	bad := uint64(1234)
	dst.WriteLeaf(bad, randomBytes(r, BlockSize))

	for _, c := range []*CountingKV{srcBlocks, srcNodes, dstBlocks, dstNodes} {
		c.Reset()
	}

	leaves := Diff(src, dst)
	if !reflect.DeepEqual(leaves, []uint64{bad}) {
		t.Fatalf("Diff leaves = %v, want [%d]", leaves, bad)
	}

	// 4096 叶共 4369 个节点；单点损坏只应访问根到叶路径附近的节点。
	if srcNodes.Gets == 0 || srcNodes.Gets >= 200 || dstNodes.Gets >= 200 {
		t.Fatalf("node accesses src=%d dst=%d, want 0 < n << 4369", srcNodes.Gets, dstNodes.Gets)
	}
	t.Logf("diff node accesses: src=%d dst=%d (full tree has 4369 nodes)", srcNodes.Gets, dstNodes.Gets)
	if srcBlocks.Gets != 0 || dstBlocks.Gets != 0 {
		t.Fatalf("diff must not read leaf data, got src=%d dst=%d", srcBlocks.Gets, dstBlocks.Gets)
	}

	for _, c := range []*CountingKV{srcBlocks, srcNodes, dstBlocks, dstNodes} {
		c.Reset()
	}
	if err := Repair(src, dst, leaves); err != nil {
		t.Fatalf("Repair: %v", err)
	}

	gotReads := leafIndices(srcBlocks.GetKeys)
	gotWrites := leafIndices(dstBlocks.PutKeys)
	if !reflect.DeepEqual(gotReads, []uint64{bad}) || !reflect.DeepEqual(gotWrites, []uint64{bad}) {
		t.Fatalf("repair access range: reads=%v writes=%v, want only leaf %d", gotReads, gotWrites, bad)
	}
	if src.Root() != dst.Root() {
		t.Fatal("roots differ after repair")
	}
}

// 缺失叶与全零叶必须区分：哈希不同，且 Diff/Repair 能双向修复。
func TestMissingLeafDiffersFromZeroLeaf(t *testing.T) {
	if leafHashOf(make([]byte, BlockSize)) == absentLeafHash {
		t.Fatal("zero block and missing leaf must hash differently")
	}

	r := rand.New(rand.NewSource(2))
	content := make([][]byte, 16)
	for i := range content {
		content[i] = randomBytes(r, BlockSize)
	}

	build := func(missingIdx, zeroIdx uint64) *Tree {
		tr := NewTree(NewMemKV(), NewMemKV(), 16)
		for i := uint64(0); i < 16; i++ {
			switch i {
			case missingIdx: // 保持缺失
			case zeroIdx:
				tr.WriteLeaf(i, make([]byte, BlockSize))
			default:
				tr.WriteLeaf(i, content[i])
			}
		}
		return tr
	}

	src := build(3, 7) // 叶 3 缺失，叶 7 全零
	dst := build(7, 3) // 叶 3 全零，叶 7 缺失

	if src.Root() == dst.Root() {
		t.Fatal("roots must differ when missing/zero leaves are swapped")
	}
	leaves := Diff(src, dst)
	if !reflect.DeepEqual(leaves, []uint64{3, 7}) {
		t.Fatalf("Diff leaves = %v, want [3 7]", leaves)
	}
	if err := Repair(src, dst, leaves); err != nil {
		t.Fatalf("Repair: %v", err)
	}
	if _, err := dst.ReadLeaf(3); !errors.Is(err, ErrMissing) {
		t.Fatalf("dst leaf 3 should be missing after repair, err=%v", err)
	}
	if data, _ := dst.ReadLeaf(7); !bytes.Equal(data, make([]byte, BlockSize)) {
		t.Fatal("dst leaf 7 should be a zero block after repair")
	}
	if src.Root() != dst.Root() || Digest(src) != Digest(dst) {
		t.Fatal("src and dst differ after repair")
	}
}

// 修复读取期间源版本变化：发布必须中止，目标不得混入两个源版本。
func TestRepairDoesNotMixSourceVersions(t *testing.T) {
	r := rand.New(rand.NewSource(3))
	src, srcBlocks, srcNodes := countedTree(randomBytes(r, 256*BlockSize))
	dst, dstBlocks, _ := cloneCounted(src, srcBlocks, srcNodes)

	dst.WriteLeaf(10, randomBytes(r, BlockSize))
	dst.WriteLeaf(200, randomBytes(r, BlockSize))
	corruptedRoot := dst.Root()

	leaves := Diff(src, dst)
	if !reflect.DeepEqual(leaves, []uint64{10, 200}) {
		t.Fatalf("Diff leaves = %v, want [10 200]", leaves)
	}

	// 第一次读取源块时模拟源被并发修改（版本递增）。
	mutated := false
	srcBlocks.OnGet = func(string) {
		if !mutated {
			mutated = true
			src.WriteLeaf(5, randomBytes(r, BlockSize))
		}
	}
	dstBlocks.Reset()

	err := Repair(src, dst, leaves)
	if !errors.Is(err, ErrVersionConflict) {
		t.Fatalf("Repair err = %v, want ErrVersionConflict", err)
	}
	if dstBlocks.Puts != 0 || dstBlocks.Deletes != 0 {
		t.Fatalf("aborted repair must not publish, puts=%d deletes=%d", dstBlocks.Puts, dstBlocks.Deletes)
	}
	if dst.Root() != corruptedRoot {
		t.Fatal("dst root changed despite aborted repair (mixed versions)")
	}

	// 源稳定后重试应成功。
	srcBlocks.OnGet = nil
	if err := Repair(src, dst, Diff(src, dst)); err != nil {
		t.Fatalf("retry Repair: %v", err)
	}
	if src.Root() != dst.Root() {
		t.Fatal("roots differ after retry")
	}
}

// 随机损坏后，Diff 恰好定位损坏叶，修复后全量摘要一致。
func TestRandomCorruptionFullDigest(t *testing.T) {
	r := rand.New(rand.NewSource(42))
	src, srcBlocks, srcNodes := countedTree(randomBytes(r, 4096*BlockSize))
	dst, _, _ := cloneCounted(src, srcBlocks, srcNodes)

	perm := r.Perm(4096)
	corrupted := make([]uint64, 0, 64)
	for _, pi := range perm[:64] {
		idx := uint64(pi)
		corrupted = append(corrupted, idx)
		switch r.Intn(3) {
		case 0: // 篡改内容
			dst.WriteLeaf(idx, randomBytes(r, BlockSize))
		case 1: // 删除（缺失）
			dst.WriteLeaf(idx, nil)
		case 2: // 置全零
			dst.WriteLeaf(idx, make([]byte, BlockSize))
		}
	}
	sortUint64s(corrupted)

	if Digest(src) == Digest(dst) {
		t.Fatal("digests should differ after corruption")
	}

	leaves := Diff(src, dst)
	if !reflect.DeepEqual(leaves, corrupted) {
		t.Fatalf("Diff leaves != corrupted set\n got: %v\nwant: %v", leaves, corrupted)
	}
	if err := Repair(src, dst, leaves); err != nil {
		t.Fatalf("Repair: %v", err)
	}
	if src.Root() != dst.Root() {
		t.Fatal("roots differ after repair")
	}
	if Digest(src) != Digest(dst) {
		t.Fatal("full digests differ after repair")
	}
	if rest := Diff(src, dst); len(rest) != 0 {
		t.Fatalf("Diff after repair = %v, want empty", rest)
	}
}

// 非整块对齐的数据也能正确切分与读回。
func TestBuildRoundTrip(t *testing.T) {
	r := rand.New(rand.NewSource(7))
	data := randomBytes(r, 10000) // 不是 BlockSize 的整数倍
	tr := Build(NewMemKV(), NewMemKV(), data)

	var back []byte
	for i := uint64(0); i < 10; i++ {
		b, err := tr.ReadLeaf(i)
		if err != nil {
			t.Fatalf("ReadLeaf(%d): %v", i, err)
		}
		back = append(back, b...)
	}
	if !bytes.Equal(back, data) {
		t.Fatal("round trip mismatch")
	}
	if _, err := tr.ReadLeaf(10); !errors.Is(err, ErrMissing) {
		t.Fatalf("padding leaf should be missing, err=%v", err)
	}
}

func sortUint64s(s []uint64) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j] < s[j-1]; j-- {
			s[j], s[j-1] = s[j-1], s[j]
		}
	}
}
