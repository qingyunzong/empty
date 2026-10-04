// Package kvmerge 实现面向 LSM 树的多版本段合并器：处理同一键的
// 多版本值与删除标记（墓碑），感知已注册快照读者的序号，仅当旧值
// 不可能复活时才删除墓碑，并为每个条目输出去留原因。
package kvmerge

import (
	"fmt"
	"sort"
	"strings"
)

// LatestSeq 表示“最新读”的读取序号（大于任何真实写序号）。
const LatestSeq = ^uint64(0)

// Entry 是某个键的一次带序号的写操作；Del 为 true 表示墓碑（删除标记）。
type Entry struct {
	Key string
	Seq uint64
	Val string
	Del bool
}

// String 返回条目的可读形式。
func (e Entry) String() string {
	if e.Del {
		return fmt.Sprintf("%s@%d<墓碑>", e.Key, e.Seq)
	}
	return fmt.Sprintf("%s@%d=%q", e.Key, e.Seq, e.Val)
}

// Segment 是一层已排序的数据段，条目按 (Key 升序, Seq 降序) 排列。
type Segment struct {
	Level   int
	Entries []Entry
}

// NewSegment 构造一个段，并按 (Key 升序, Seq 降序) 排序条目。
func NewSegment(level int, entries []Entry) Segment {
	sorted := append([]Entry(nil), entries...)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Key != sorted[j].Key {
			return sorted[i].Key < sorted[j].Key
		}
		return sorted[i].Seq > sorted[j].Seq
	})
	return Segment{Level: level, Entries: sorted}
}

// Decision 记录一次合并中单个输入条目的去留及原因。
type Decision struct {
	Entry  Entry
	Kept   bool
	Reason string
}

// Result 是合并输出：Output 为保留条目（按 Key 升序、Seq 降序），
// Decisions 覆盖每个输入条目（同样的顺序），说明保留或丢弃的原因。
type Result struct {
	Output    []Entry
	Decisions []Decision
}

// Merge 将若干段（可含同一键的多版本与墓碑）合并为一段。
//
// segments 应按从新到旧的层序传入；同一 (Key, Seq) 出现在多段时以
// 更靠前的段为准。snapshots 为当前已注册快照读者的序号；bottomMost
// 为 true 表示合并范围之下不存在更旧的数据（即压缩到最底层），
// 只有此时墓碑才可能被安全删除。
func Merge(segments []Segment, snapshots []uint64, bottomMost bool) Result {
	byKey := make(map[string][]Entry)
	for _, seg := range segments {
		for _, e := range seg.Entries {
			byKey[e.Key] = append(byKey[e.Key], e)
		}
	}
	keys := make([]string, 0, len(byKey))
	for k := range byKey {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	snaps := append([]uint64(nil), snapshots...)
	sort.Slice(snaps, func(i, j int) bool { return snaps[i] < snaps[j] })
	uniq := make([]uint64, 0, len(snaps))
	for _, s := range snaps {
		if len(uniq) == 0 || uniq[len(uniq)-1] != s {
			uniq = append(uniq, s)
		}
	}

	var res Result
	for _, k := range keys {
		kept, decs := mergeKey(byKey[k], uniq, bottomMost)
		res.Output = append(res.Output, kept...)
		res.Decisions = append(res.Decisions, decs...)
	}
	return res
}

// mergeKey 合并单个键的全部版本，返回保留版本（Seq 降序）与覆盖
// 每个版本的决策（Seq 降序）。
func mergeKey(entries []Entry, snaps []uint64, bottomMost bool) ([]Entry, []Decision) {
	versions := dedupVersions(entries)

	// 标记每个版本被哪些读者需要：最新读需要最新版本；每个快照
	// 读者需要其序号处可见的那个版本。
	needed := make(map[int][]string)
	mark := func(idx int, who string) { needed[idx] = append(needed[idx], who) }
	mark(0, "最新读")
	for _, s := range snaps {
		if idx := visibleAt(versions, s); idx >= 0 {
			mark(idx, fmt.Sprintf("快照seq=%d", s))
		}
	}
	idxs := make([]int, 0, len(needed))
	for i := range needed {
		idxs = append(idxs, i)
	}
	sort.Ints(idxs)

	keptIdx := make(map[int]bool)
	var kept []Entry
	decs := make([]Decision, len(versions))
	for _, i := range idxs {
		v := versions[i]
		who := strings.Join(needed[i], "、")
		if !v.Del {
			keptIdx[i] = true
			kept = append(kept, v)
			decs[i] = Decision{Entry: v, Kept: true, Reason: fmt.Sprintf("保留：对%s可见", who)}
			continue
		}
		olderNeeded := false
		for _, j := range idxs {
			if j > i {
				olderNeeded = true
				break
			}
		}
		if bottomMost && !olderNeeded {
			decs[i] = Decision{Entry: v, Kept: false, Reason: fmt.Sprintf("删除墓碑：虽对%s可见，但已压缩到最底层且无读者可见更旧版本，旧值不可能复活", who)}
			continue
		}
		keptIdx[i] = true
		kept = append(kept, v)
		reason := fmt.Sprintf("保留墓碑：对%s可见", who)
		if !bottomMost {
			reason += "；未压缩到最底层，下层旧值可能复活，墓碑必须保留"
		} else {
			reason += "；更旧版本仍被其他快照读者需要，删除墓碑会使旧值复活"
		}
		decs[i] = Decision{Entry: v, Kept: true, Reason: reason}
	}
	for i, v := range versions {
		if len(needed[i]) > 0 {
			continue
		}
		shadower := -1
		for j := i - 1; j >= 0; j-- {
			if keptIdx[j] {
				shadower = j
				break
			}
		}
		reason := "丢弃：无任何已注册读者可见"
		if shadower >= 0 {
			sv := versions[shadower]
			kind := "新版本"
			if sv.Del {
				kind = "墓碑"
			}
			reason = fmt.Sprintf("丢弃：无读者可见，被%s seq=%d 遮蔽", kind, sv.Seq)
		}
		decs[i] = Decision{Entry: v, Kept: false, Reason: reason}
	}
	return kept, decs
}

// dedupVersions 按 Seq 降序排序并去除重复序号（保留先出现者，
// 即更靠前段中的版本）。
func dedupVersions(entries []Entry) []Entry {
	sorted := append([]Entry(nil), entries...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Seq > sorted[j].Seq })
	out := make([]Entry, 0, len(sorted))
	for i, e := range sorted {
		if i > 0 && e.Seq == sorted[i-1].Seq {
			continue
		}
		out = append(out, e)
	}
	return out
}

// visibleAt 返回在序号 readSeq 处可见的版本下标（Seq <= readSeq 的
// 最新版本）；不存在时返回 -1。versions 必须按 Seq 降序排列。
func visibleAt(versions []Entry, readSeq uint64) int {
	i := sort.Search(len(versions), func(i int) bool { return versions[i].Seq <= readSeq })
	if i < len(versions) {
		return i
	}
	return -1
}
