package frameindex

import (
	"fmt"
	"reflect"
	"sort"
)

// ModelClosure 是独立的全图 DFS 参考模型：
// 对每个目标帧，从全图上做朴素的可达性 DFS，取并集作为闭包。
// 它刻意不复用 SeekInterval 的任何内部逻辑，用于交叉核对。
func (ix *Index) ModelClosure(targets []string) map[string]bool {
	reachable := make(map[string]bool)
	var dfs func(id string)
	dfs = func(id string) {
		if reachable[id] {
			return
		}
		f, ok := ix.frames[id]
		if !ok {
			return
		}
		reachable[id] = true
		for _, ref := range f.Refs {
			dfs(ref)
		}
	}
	for _, t := range targets {
		dfs(t)
	}
	return reachable
}

// ModelMissing 独立地枚举闭包内所有指向不存在帧的参考边。
func (ix *Index) ModelMissing(closure map[string]bool) []MissingRef {
	var out []MissingRef
	for id := range closure {
		f := ix.frames[id]
		for _, ref := range f.Refs {
			if _, ok := ix.frames[ref]; !ok {
				out = append(out, MissingRef{From: id, RefID: ref})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].From != out[j].From {
			return out[i].From < out[j].From
		}
		return out[i].RefID < out[j].RefID
	})
	return out
}

// ModelHasCycle 独立地用全图 DFS（三色标记）判断闭包内是否存在依赖环。
func (ix *Index) ModelHasCycle(closure map[string]bool) bool {
	const (
		white = 0
		gray  = 1
		black = 2
	)
	color := make(map[string]int, len(closure))
	var dfs func(id string) bool
	dfs = func(id string) bool {
		color[id] = gray
		for _, ref := range ix.frames[id].Refs {
			if !closure[ref] {
				continue
			}
			switch color[ref] {
			case gray:
				return true
			case white:
				if dfs(ref) {
					return true
				}
			}
		}
		color[id] = black
		return false
	}
	for id := range closure {
		if color[id] == white {
			if dfs(id) {
				return true
			}
		}
	}
	return false
}

// CheckAgainstModel 用全图 DFS 参考模型核对 SeekInterval 的结果：
//  1. 闭包集合必须与模型可达集完全一致；
//  2. 缺失参考列表必须与模型枚举一致；
//  3. Plan 报告有环当且仅当模型判定有环。
func (ix *Index) CheckAgainstModel(p *Plan) error {
	model := ix.ModelClosure(p.Targets)

	got := make(map[string]bool, len(p.Closure))
	for _, id := range p.Closure {
		got[id] = true
	}
	if !reflect.DeepEqual(got, model) {
		return fmt.Errorf("frameindex: closure mismatch: seek=%v model=%v",
			sortedKeys(got), sortedKeys(model))
	}

	if want := ix.ModelMissing(model); !reflect.DeepEqual(p.Missing, want) {
		return fmt.Errorf("frameindex: missing mismatch: seek=%v model=%v", p.Missing, want)
	}

	if modelCyc := ix.ModelHasCycle(model); (len(p.Cycles) > 0) != modelCyc {
		return fmt.Errorf("frameindex: cycle mismatch: seek reports %v cycles, model says cycle=%v",
			len(p.Cycles), modelCyc)
	}
	return nil
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
