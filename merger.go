package q220

import (
	"errors"
	"sort"
	"strconv"
)

// ErrNotIsomorphic 表示两个抓取图在固定 IRI 标签下不同构，无法合并。
var ErrNotIsomorphic = errors.New("q220: graphs are not isomorphic")

// BlankMapping 描述合并时来源图匿名标识到目标图匿名标识的一个对应。
type BlankMapping struct {
	From string
	To   string
}

// MergeReport 是一次同构合并的结果。
type MergeReport struct {
	// Isomorphic 为 true 时两个图同构并已合并。
	Isomorphic bool
	// BlankMapping 给出来源图每个匿名节点到目标图匿名节点的对应，
	// 按来源匿名标识字节序排列。
	BlankMapping []BlankMapping
	// Base 是合并后累积图的规范化结果。
	Base *Result
}

// Merger 是供知识采集服务调用方使用的有状态合并器：
// 逐张提交抓取图，同构则合并，不同构则拒绝。
type Merger interface {
	// Base 返回当前已累积图的规范化结果，尚未提交时返回 nil。
	Base() *Result
	// Merge 提交一张抓取图。首张图直接采用；后续图必须与累积图同构，
	// 同构时返回匿名节点对应并保留累积图，不同构时返回 ErrNotIsomorphic。
	Merge(triples []Triple) (*MergeReport, error)
}

type merger struct {
	base       *Result
	baseTriple []Triple
	baseBlanks []string
}

// NewMerger 创建一个空的合并器。
func NewMerger() Merger {
	return &merger{}
}

func (m *merger) Base() *Result {
	return m.base
}

func (m *merger) Merge(triples []Triple) (*MergeReport, error) {
	res, err := Canonicalize(triples)
	if err != nil {
		return nil, err
	}
	if m.base == nil {
		m.base = res
		m.baseTriple = append([]Triple(nil), triples...)
		m.baseBlanks = blankLabels(triples)
		return &MergeReport{Isomorphic: true, Base: res}, nil
	}

	report, err := MergeGraphs(m.baseTriple, triples)
	if err != nil {
		return nil, err
	}
	report.Base = m.base
	return report, nil
}

// MergeGraphs 判断两张抓取图是否同构；同构时返回匿名节点对应关系。
// 同构判定基于规范化字节序列：固定 IRI 标签下，两图同构当且仅当其规范
// 编码一致；对应关系由双方匿名节点映射到的规范编号反推得到。
func MergeGraphs(base, incoming []Triple) (*MergeReport, error) {
	baseRes, err := Canonicalize(base)
	if err != nil {
		return nil, err
	}
	inRes, err := Canonicalize(incoming)
	if err != nil {
		return nil, err
	}
	if baseRes.BlankCount != inRes.BlankCount ||
		!equalBytes(baseRes.Encoding, inRes.Encoding) {
		return nil, ErrNotIsomorphic
	}

	baseCanon := canonicalNumberByLabel(baseRes)
	inCanon := canonicalNumberByLabel(inRes)

	report := &MergeReport{Isomorphic: true}
	for _, label := range blankLabels(incoming) {
		num := inCanon[label]
		report.BlankMapping = append(report.BlankMapping, BlankMapping{
			From: label,
			To:   baseCanonNumberToLabel(baseCanon, num),
		})
	}
	return report, nil
}

func blankLabels(triples []Triple) []string {
	seen := make(map[string]struct{})
	for _, t := range triples {
		for _, n := range [2]Node{t.Subject, t.Object} {
			if n.Type == Blank {
				seen[n.Value] = struct{}{}
			}
		}
	}
	out := make([]string, 0, len(seen))
	for v := range seen {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

func canonicalNumberByLabel(res *Result) map[string]int {
	out := make(map[string]int, res.BlankCount)
	for _, nm := range res.Mapping {
		if nm.Source.Type == Blank {
			num, err := strconv.Atoi(nm.Canonical.Value)
			if err != nil {
				panic("q220: internal error: invalid canonical blank number")
			}
			out[nm.Source.Value] = num
		}
	}
	return out
}

func baseCanonNumberToLabel(m map[string]int, num int) string {
	for label, v := range m {
		if v == num {
			return label
		}
	}
	return ""
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
