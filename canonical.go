// Package q220 提供知识采集服务使用的 RDF 图规范化（canonicalization）组件。
//
// 输入为无序三元组集合：主语与宾语可以是 IRI 或匿名（blank）节点，谓语只能是
// IRI。组件对匿名节点到 0..n-1 的全部双射求字节字典序最小的排序编码作为规范
// 结果，并输出原节点到规范节点的映射。搜索过程使用结构分区（颜色细化）与
// 下界剪枝，同时保证结果与全排列枚举完全一致。
package q220

import (
	"encoding/binary"
	"errors"
)

// MaxBlanks 是单个图允许的匿名节点数量上限。
const MaxBlanks = 8

// 节点类型标签字节。
const (
	typeIRI   byte = 'I'
	typeBlank byte = 'B'
)

// NodeType 标识节点是 IRI 还是匿名节点。
type NodeType uint8

const (
	// IRI 节点，Value 为 IRI 文本。
	IRI NodeType = iota + 1
	// Blank 匿名节点，Value 为调用方给定的匿名标识。
	Blank
)

// Node 是三元组中的一个节点。
type Node struct {
	Type  NodeType
	Value string
}

// Triple 是一条输入三元组。
type Triple struct {
	Subject   Node
	Predicate Node
	Object    Node
}

// 输入校验错误。
var (
	// ErrEmptyNode 表示 IRI 或匿名节点的内容为空。
	ErrEmptyNode = errors.New("q220: node content must not be empty")
	// ErrPredicateIRI 表示谓语不是 IRI。
	ErrPredicateIRI = errors.New("q220: predicate must be an IRI")
	// ErrInvalidNodeType 表示节点类型既不是 IRI 也不是 Blank。
	ErrInvalidNodeType = errors.New("q220: invalid node type")
	// ErrTooManyBlanks 表示匿名节点数量超过 MaxBlanks。
	ErrTooManyBlanks = errors.New("q220: too many blank nodes")
)

// CanonicalNode 是规范结果中的节点。匿名节点编号为无符号整数 0..n-1，
// IRI 节点保留原文本。
type CanonicalNode struct {
	Type  NodeType
	Value string // IRI：原文本；Blank：规范编号的无前导零十进制
}

// CanonicalTriple 是规范化后的三元组。
type CanonicalTriple struct {
	Subject   CanonicalNode
	Predicate CanonicalNode
	Object    CanonicalNode
}

// NodeMapping 记录一个原节点及其规范对应节点。
type NodeMapping struct {
	Source    Node
	Canonical CanonicalNode
}

// Result 是一次规范化的结果。
type Result struct {
	// Encoding 是规范字节序列：全部三元组按编码字节字典序排序后顺序连接。
	Encoding []byte
	// Triples 是使用规范节点编号后的有序三元组（已去重、已排序）。
	Triples []CanonicalTriple
	// Mapping 是原节点到规范节点的映射，按输入中首次出现顺序排列。
	Mapping []NodeMapping
	// BlankCount 是匿名节点数量 n。
	BlankCount int
}

// EncodeNode 按规范规则编码单个节点：
// 类型字节（I/B）+ 32 位大端内容长度 + UTF-8 内容。
// 匿名节点的内容按无前导零十进制处理。
func EncodeNode(n Node) []byte {
	content := []byte(n.Value)
	if n.Type == Blank {
		content = []byte(trimLeadingZeros(n.Value))
	}
	buf := make([]byte, 1+4+len(content))
	if n.Type == Blank {
		buf[0] = typeBlank
	} else {
		buf[0] = typeIRI
	}
	binary.BigEndian.PutUint32(buf[1:5], uint32(len(content)))
	copy(buf[5:], content)
	return buf
}

func trimLeadingZeros(s string) string {
	i := 0
	for i < len(s) && s[i] == '0' {
		i++
	}
	if i == len(s) {
		return "0"
	}
	return s[i:]
}

func encodeCanonicalNode(n CanonicalNode) []byte {
	return EncodeNode(Node{Type: n.Type, Value: n.Value})
}

// Stats 记录规范化搜索过程中的分支统计，可用于验证剪枝确实生效。
type Stats struct {
	// Refinements 是颜色细化（结构分区）调用次数。
	Refinements int
	// Branches 是实际展开的搜索分支数。
	Branches int
	// Bounds 是被下界剪枝剪掉的分支数。
	Bounds int
	// Leaves 是到达完整赋值的叶子数。
	Leaves int
}

// Canonicalize 对无序、可能含重复项的三元组集合做规范化。
// 重复三元组在规范化前去重；返回的结果对匿名节点的任意改名保持不变。
func Canonicalize(triples []Triple) (*Result, error) {
	g, err := buildGraph(triples)
	if err != nil {
		return nil, err
	}
	stats := &Stats{}
	enc, perm := searchCanonical(g, stats)
	return buildResult(g, enc, perm), nil
}

// CanonicalizeWithStats 与 Canonicalize 相同，额外返回搜索统计。
func CanonicalizeWithStats(triples []Triple) (*Result, *Stats, error) {
	g, err := buildGraph(triples)
	if err != nil {
		return nil, nil, err
	}
	stats := &Stats{}
	enc, perm := searchCanonical(g, stats)
	return buildResult(g, enc, perm), stats, nil
}
