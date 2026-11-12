package dataeng

import (
	"errors"
	"fmt"
	"regexp"
	"sort"
)

// XML 1.0 固定命名空间与规则中使用的来源占位符。
const (
	XMLURI       = "http://www.w3.org/XML/1998/namespace"
	XMLPrefix    = "xml"
	XMLNSPrefix  = "xmlns"
	InitialScope = "$initial"
	DefaultToken = "#default"
)

// 输入树只允许两种节点：元素与文本。
const (
	KindElement = "element"
	KindText    = "text"
)

// Node 是已解析树的节点接口。实现类型只可能是 *Element 或 *Text，
// 其他类型一律拒绝（不支持 DTD、处理指令或注释节点）。
type Node interface {
	nodeID() string
	nodeKind() string
}

// Attr 是元素的普通属性（命名空间声明放在 Element.Decls 中）。
type Attr struct {
	Prefix string
	Local  string
	Value  string
}

// Decl 是一条命名空间声明。Prefix 为空表示默认命名空间声明。
type Decl struct {
	Prefix string
	URI    string
}

// Element 是元素节点。所有 ID 在树中唯一。
type Element struct {
	ID     string
	Prefix string
	Local  string
	Decls  []Decl
	Attrs  []Attr
	Kids   []Node
}

func (e *Element) nodeID() string   { return e.ID }
func (e *Element) nodeKind() string { return KindElement }

// Text 是文本节点。
type Text struct {
	ID   string
	Data string
}

func (t *Text) nodeID() string   { return t.ID }
func (t *Text) nodeKind() string { return KindText }

// Options 控制序列化限制与调用方的 inclusive 前缀集合。
type Options struct {
	// MaxDepth 限制元素嵌套深度（根元素深度为 1）。<=0 时使用默认值。
	MaxDepth int
	// MaxOutputBytes 限制输出字节数。<=0 时使用默认值。
	MaxOutputBytes int
	// InclusivePrefixes 是调用方传入的可见前缀集合，"#default" 表示默认。
	InclusivePrefixes []string
}

// 默认限制值。
const (
	DefaultMaxDepth       = 10000
	DefaultMaxOutputBytes = 10 << 20
)

// SourceKind 标注一个输出片段的来源类型。
type SourceKind string

const (
	SourceElement   SourceKind = "element"
	SourceAttr      SourceKind = "attr"
	SourceText      SourceKind = "text"
	SourceDecl      SourceKind = "decl"
	SourceSyntax    SourceKind = "syntax"
	SourceInclusive SourceKind = "inclusive"
)

// SourceRef 定位一个输出片段的来源。祖先借入的声明通过 DeclElemID
// 定位到实际声明该绑定的元素节点。
type SourceRef struct {
	Kind       SourceKind
	NodeID     string
	AttrPrefix string
	AttrLocal  string
	DeclPrefix string
	// DeclElemID 是实际输出这条 xmlns 绑定的声明节点所在元素 ID。
	DeclElemID string
	// Inclusive 为 true 时表示该前缀因调用方 inclusive 集合而变为可见。
	Inclusive bool
}

// Segment 是输出中的一个字节段。相邻段 Offset+Len 连续覆盖全部输出。
type Segment struct {
	Offset int
	Len    int
	Source SourceRef
}

// Output 是一次成功序列化的结果。
type Output struct {
	Bytes    []byte
	Segments []Segment
}

var (
	nameRe   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.-]*$`)
	schemeRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)
)

// Serialize 对 root 中 ID 为 elementID 的元素做 exclusive-canonical
// 子集序列化。输入是完整已解析树，本函数不解析任何 XML 文本；
// 全部校验通过后才交付结果。
func Serialize(root Node, elementID string, opts *Options) (*Output, error) {
	cfg := Options{MaxDepth: DefaultMaxDepth, MaxOutputBytes: DefaultMaxOutputBytes}
	if opts != nil {
		cfg = *opts
		if cfg.MaxDepth <= 0 {
			cfg.MaxDepth = DefaultMaxDepth
		}
		if cfg.MaxOutputBytes <= 0 {
			cfg.MaxOutputBytes = DefaultMaxOutputBytes
		}
	}

	ids, depth, err := validateStructure(root, elementID, cfg.MaxDepth)
	if err != nil {
		return nil, err
	}
	scopes, err := validateSemantics(root, ids, depth)
	if err != nil {
		return nil, err
	}
	for _, p := range cfg.InclusivePrefixes {
		if p != DefaultToken && !nameRe.MatchString(p) {
			return nil, fmt.Errorf("invalid inclusive prefix %q", p)
		}
	}

	selected, ok := ids[elementID].(*Element)
	if !ok {
		return nil, fmt.Errorf("selected id %q is not an element", elementID)
	}

	s := &serializer{
		cfg:    cfg,
		scopes: scopes,
		out:    make([]byte, 0, 256),
	}
	rendered := map[string]binding{
		XMLPrefix: {uri: XMLURI, elemID: InitialScope},
		"":        {uri: "", elemID: InitialScope},
	}
	if err := s.renderElement(selected, rendered, scopes[selected.ID]); err != nil {
		return nil, err
	}
	return s.flatten(), nil
}

// validateStructure 检查节点类型、ID 唯一、单根、无环、无多父、
// 选中 ID 存在以及深度限制，返回 ID 到节点的映射和元素深度映射。
func validateStructure(root Node, elementID string, maxDepth int) (map[string]Node, map[string]int, error) {
	if root == nil {
		return nil, nil, errors.New("nil root node")
	}
	if _, ok := root.(*Element); !ok {
		return nil, nil, errors.New("root must be an element")
	}
	ids := map[string]Node{}
	depth := map[string]int{}
	var walk func(n, parent Node, d int) error
	walk = func(n, parent Node, d int) error {
		if n == nil {
			return errors.New("nil child of element " + safeID(parent))
		}
		id := n.nodeID()
		if id == "" {
			return errors.New("node with empty id")
		}
		if existing, ok := ids[id]; ok {
			if existing != n {
				return fmt.Errorf("duplicate node id %q", id)
			}
			return fmt.Errorf("node %q has multiple parents or the tree contains a cycle", id)
		}
		ids[id] = n
		switch e := n.(type) {
		case *Element:
			if d > maxDepth {
				return fmt.Errorf("element depth %d exceeds limit %d at %q", d, maxDepth, id)
			}
			depth[id] = d
			for _, kid := range e.Kids {
				if err := walk(kid, n, d+1); err != nil {
					return err
				}
			}
		case *Text:
		default:
			return fmt.Errorf("node %q has unsupported kind %q; only element and text are allowed", id, n.nodeKind())
		}
		return nil
	}
	if err := walk(root, nil, 1); err != nil {
		return nil, nil, err
	}
	if _, ok := ids[elementID]; !ok {
		return nil, nil, fmt.Errorf("selected element id %q not found", elementID)
	}
	return ids, depth, nil
}

func safeID(n Node) string {
	if n == nil {
		return "<root>"
	}
	return n.nodeID()
}

// binding 记录一个前缀当前实际绑定的 URI，以及声明该绑定的元素 ID。
type binding struct {
	uri    string
	elemID string
}

// validateSemantics 遍历整棵树，检查名称、命名空间声明、属性展开名、
// 可见前缀绑定以及文本标量合法性，并为每个元素记录实际 in-scope 绑定。
func validateSemantics(root Node, ids map[string]Node, depth map[string]int) (map[string]map[string]binding, error) {
	scopes := make(map[string]map[string]binding, len(ids))
	initial := map[string]binding{
		XMLPrefix: {uri: XMLURI, elemID: InitialScope},
		"":        {uri: "", elemID: InitialScope},
	}
	var walk func(n Node, scope map[string]binding) error
	walk = func(n Node, scope map[string]binding) error {
		e, ok := n.(*Element)
		if !ok {
			t := n.(*Text)
			if !legalScalars(t.Data) {
				return fmt.Errorf("text node %q contains illegal XML 1.0 character", t.ID)
			}
			return nil
		}
		if e.Prefix == XMLNSPrefix || !nameRe.MatchString(e.Local) || (e.Prefix != "" && !nameRe.MatchString(e.Prefix)) {
			return fmt.Errorf("element %q has invalid name", e.ID)
		}
		next := make(map[string]binding, len(scope)+len(e.Decls))
		for p, b := range scope {
			next[p] = b
		}
		seenDecl := map[string]bool{}
		for _, d := range e.Decls {
			if d.Prefix == XMLNSPrefix {
				return fmt.Errorf("element %q declares xmlns as a prefix", e.ID)
			}
			if d.Prefix != "" && !nameRe.MatchString(d.Prefix) {
				return fmt.Errorf("element %q declares namespace with invalid prefix %q", e.ID, d.Prefix)
			}
			if seenDecl[d.Prefix] {
				return fmt.Errorf("element %q declares prefix %q more than once", e.ID, d.Prefix)
			}
			seenDecl[d.Prefix] = true
			if d.URI == "" {
				if d.Prefix != "" {
					return fmt.Errorf("element %q binds non-default prefix %q to empty URI", e.ID, d.Prefix)
				}
			} else if !validURI(d.URI) {
				return fmt.Errorf("element %q declares invalid namespace URI %q", e.ID, d.URI)
			}
			if d.Prefix == XMLPrefix && d.URI != XMLURI {
				return fmt.Errorf("element %q rebinds xml prefix", e.ID)
			}
			if d.URI == XMLURI && d.Prefix != XMLPrefix {
				return fmt.Errorf("element %q binds the fixed xml URI to prefix %q", e.ID, d.Prefix)
			}
			next[d.Prefix] = binding{uri: d.URI, elemID: e.ID}
		}
		if e.Prefix != "" {
			b, ok := next[e.Prefix]
			if !ok || b.uri == "" {
				return fmt.Errorf("element %q uses unbound prefix %q", e.ID, e.Prefix)
			}
		}
		seenAttr := map[string]bool{}
		for _, a := range e.Attrs {
			if a.Prefix == XMLNSPrefix || (a.Prefix == "" && a.Local == XMLNSPrefix) {
				return fmt.Errorf("element %q has forbidden xmlns attribute", e.ID)
			}
			if !nameRe.MatchString(a.Local) || (a.Prefix != "" && !nameRe.MatchString(a.Prefix)) {
				return fmt.Errorf("element %q has invalid attribute name", e.ID)
			}
			if a.Prefix != "" {
				b, ok := next[a.Prefix]
				if !ok || b.uri == "" {
					return fmt.Errorf("element %q attribute uses unbound prefix %q", e.ID, a.Prefix)
				}
			}
			expanded := attrExpandedName(a, next)
			if seenAttr[expanded] {
				return fmt.Errorf("element %q has duplicate attribute expanded name %q", e.ID, expanded)
			}
			seenAttr[expanded] = true
			if !legalScalars(a.Value) {
				return fmt.Errorf("attribute %q of element %q contains illegal XML 1.0 character", a.Local, e.ID)
			}
		}
		scopes[e.ID] = next
		for _, kid := range e.Kids {
			if err := walk(kid, next); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(root, initial); err != nil {
		return nil, err
	}
	return scopes, nil
}

func attrExpandedName(a Attr, scope map[string]binding) string {
	if a.Prefix == "" {
		// 无前缀属性不进入默认命名空间。
		return "\x00" + a.Local
	}
	return scope[a.Prefix].uri + "\x00" + a.Local
}

func validURI(uri string) bool {
	if !schemeRe.MatchString(uri) {
		return false
	}
	return legalScalars(uri)
}

// legalScalars 校验字符串是合法 UTF-8，且每个码位都落在 XML 1.0
// 允许的标量范围内（不成对代理与非法字节一律拒绝）。
func legalScalars(s string) bool {
	for i := 0; i < len(s); {
		r, size := decodeRune(s[i:])
		if r == 0xFFFD && size == 1 {
			return false
		}
		switch {
		case r == 0x09 || r == 0x0A || r == 0x0D:
		case r >= 0x20 && r <= 0xD7FF:
		case r >= 0xE000 && r <= 0xFFFD:
		case r >= 0x10000 && r <= 0x10FFFF:
		default:
			return false
		}
		i += size
	}
	return true
}

func decodeRune(s string) (rune, int) {
	if len(s) == 0 {
		return 0xFFFD, 1
	}
	b := s[0]
	var r rune
	switch {
	case b < 0x80:
		return rune(b), 1
	case b < 0xC2:
		return 0xFFFD, 1
	case b < 0xE0:
		if len(s) < 2 || s[1]&0xC0 != 0x80 {
			return 0xFFFD, 1
		}
		return rune(b&0x1F)<<6 | rune(s[1]&0x3F), 2
	case b < 0xF0:
		if len(s) < 3 || s[1]&0xC0 != 0x80 || s[2]&0xC0 != 0x80 {
			return 0xFFFD, 1
		}
		r = rune(b&0x0F)<<12 | rune(s[1]&0x3F)<<6 | rune(s[2]&0x3F)
		if r >= 0xD800 && r <= 0xDFFF {
			return 0xFFFD, 1
		}
		return r, 3
	default:
		if len(s) < 4 || s[1]&0xC0 != 0x80 || s[2]&0xC0 != 0x80 || s[3]&0xC0 != 0x80 {
			return 0xFFFD, 1
		}
		r = rune(b&0x07)<<18 | rune(s[1]&0x3F)<<12 | rune(s[2]&0x3F)<<6 | rune(s[3]&0x3F)
		if r < 0x10000 || r > 0x10FFFF {
			return 0xFFFD, 1
		}
		return r, 4
	}
}

type serializer struct {
	cfg      Options
	scopes   map[string]map[string]binding
	out      []byte
	segments []segmentBuf
}

type segmentBuf struct {
	len    int
	source SourceRef
}

func (s *serializer) write(p []byte, ref SourceRef) error {
	if len(s.out)+len(p) > s.cfg.MaxOutputBytes {
		return fmt.Errorf("serialized output exceeds %d bytes", s.cfg.MaxOutputBytes)
	}
	s.out = append(s.out, p...)
	// 空声明值（xmlns=""）也要保留独立来源段，不能被相邻段吞并。
	if len(p) > 0 {
		if n := len(s.segments); n > 0 && s.segments[n-1].source == ref {
			s.segments[n-1].len += len(p)
			return nil
		}
	}
	s.segments = append(s.segments, segmentBuf{len: len(p), source: ref})
	return nil
}

func (s *serializer) writeStr(p string, ref SourceRef) error {
	return s.write([]byte(p), ref)
}

// renderElement 渲染单个元素。rendered 是独立的已渲染绑定状态，
// scope 是该元素的实际 in-scope 绑定；两者绝不混用。
func (s *serializer) renderElement(el *Element, rendered map[string]binding, scope map[string]binding) error {
	visible := map[string]bool{}
	inclusive := map[string]bool{}
	if el.Prefix != "" {
		visible[el.Prefix] = true
	} else if b, ok := scope[""]; ok && b.uri != "" {
		// 默认命名空间作用于无前缀元素：非空默认属于可见使用。
		visible[""] = true
	}
	for _, a := range el.Attrs {
		if a.Prefix != "" {
			visible[a.Prefix] = true
		}
	}
	for _, p := range s.cfg.InclusivePrefixes {
		if p == DefaultToken {
			if b, ok := scope[""]; ok && b.uri != "" {
				visible[""] = true
				inclusive[""] = true
			}
			continue
		}
		if b, ok := scope[p]; ok && b.uri != "" {
			visible[p] = true
			inclusive[p] = true
		}
	}

	prefixes := make([]string, 0, len(visible)+1)
	hasDefault := false
	for p := range visible {
		if p == "" {
			hasDefault = true
			continue
		}
		prefixes = append(prefixes, p)
	}
	sort.Strings(prefixes)
	// 实际默认为空但已渲染默认为非空时，必须输出 xmlns="" 清空，
	// 即使输入此处没有显式声明（实际绑定回落自 $initial）。
	if el.Prefix == "" && scope[""].uri == "" &&
		(rendered[""].uri != "" || explicitDefaultDecl(el)) {
		hasDefault = true
	}

	// 已渲染状态在本元素内复制，孩子退出后自然恢复到父状态。
	nextRendered := make(map[string]binding, len(rendered)+len(prefixes)+1)
	for p, b := range rendered {
		nextRendered[p] = b
	}

	syn := SourceRef{Kind: SourceSyntax, NodeID: el.ID}
	elemRef := SourceRef{Kind: SourceElement, NodeID: el.ID}
	if err := s.writeStr("<", syn); err != nil {
		return err
	}
	if err := s.writeStr(qname(el.Prefix, el.Local), elemRef); err != nil {
		return err
	}

	// 默认（空前缀）声明永远排在最前。
	if hasDefault {
		if err := s.emitDecl("", scope, rendered, nextRendered, el, inclusive, explicitDefaultDecl(el)); err != nil {
			return err
		}
	}
	for _, p := range prefixes {
		if p == XMLPrefix {
			continue
		}
		if err := s.emitDecl(p, scope, rendered, nextRendered, el, inclusive, explicitPrefixDecl(el, p)); err != nil {
			return err
		}
	}

	attrs := make([]Attr, len(el.Attrs))
	copy(attrs, el.Attrs)
	sort.SliceStable(attrs, func(i, j int) bool {
		ki := attrSortKey(attrs[i], scope)
		kj := attrSortKey(attrs[j], scope)
		return ki < kj
	})
	for _, a := range attrs {
		if err := s.writeStr(" ", syn); err != nil {
			return err
		}
		ref := SourceRef{Kind: SourceAttr, NodeID: el.ID, AttrPrefix: a.Prefix, AttrLocal: a.Local}
		if err := s.writeStr(qname(a.Prefix, a.Local), ref); err != nil {
			return err
		}
		if err := s.writeStr("=\"", syn); err != nil {
			return err
		}
		if err := s.writeStr(escapeAttr(a.Value), ref); err != nil {
			return err
		}
		if err := s.writeStr("\"", syn); err != nil {
			return err
		}
	}

	if len(el.Kids) == 0 {
		// 空元素仍输出显式起止标签。
		return s.writeStr("></"+qname(el.Prefix, el.Local)+">", syn)
	}
	if err := s.writeStr(">", syn); err != nil {
		return err
	}
	for _, kid := range el.Kids {
		switch k := kid.(type) {
		case *Text:
			ref := SourceRef{Kind: SourceText, NodeID: k.ID}
			if err := s.writeStr(escapeText(k.Data), ref); err != nil {
				return err
			}
		case *Element:
			if err := s.renderElement(k, nextRendered, s.scopes[k.ID]); err != nil {
				return err
			}
		default:
			return fmt.Errorf("node %q has unsupported kind", k.nodeID())
		}
	}
	return s.writeStr("</"+qname(el.Prefix, el.Local)+">", syn)
}

// emitDecl 仅在实际绑定与已渲染绑定不同（包括祖先借入的绑定），
// 或该绑定由当前元素显式声明时输出 xmlns 声明，并只把实际输出的
// 声明记入已渲染栈。
func (s *serializer) emitDecl(prefix string, scope, rendered, nextRendered map[string]binding, el *Element, inclusive map[string]bool, explicit bool) error {
	actual, ok := scope[prefix]
	if !ok {
		return nil
	}
	ref := SourceRef{
		Kind:       SourceDecl,
		NodeID:     actual.elemID,
		DeclPrefix: prefix,
		DeclElemID: actual.elemID,
		Inclusive:  inclusive[prefix],
	}
	// 显式声明即便 URI 与已渲染态相同也要输出，来源是当前元素。
	if explicit {
		ref.NodeID = el.ID
		ref.DeclElemID = el.ID
	} else if cur, ok := rendered[prefix]; ok && cur.uri == actual.uri {
		return nil
	}
	syn := SourceRef{Kind: SourceSyntax, NodeID: el.ID}
	name := XMLNSPrefix
	if prefix != "" {
		name += ":" + prefix
	}
	if err := s.writeStr(" "+name+"=\"", syn); err != nil {
		return err
	}
	if err := s.writeStr(escapeAttr(actual.uri), ref); err != nil {
		return err
	}
	if err := s.writeStr("\"", syn); err != nil {
		return err
	}
	nextRendered[prefix] = actual
	return nil
}

func explicitDefaultDecl(el *Element) bool {
	for _, d := range el.Decls {
		if d.Prefix == "" {
			return true
		}
	}
	return false
}

func explicitPrefixDecl(el *Element, prefix string) bool {
	for _, d := range el.Decls {
		if d.Prefix == prefix {
			return true
		}
	}
	return false
}

func attrSortKey(a Attr, scope map[string]binding) string {
	if a.Prefix == "" {
		return "\x00" + a.Local
	}
	return scope[a.Prefix].uri + "\x00" + a.Local
}

func qname(prefix, local string) string {
	if prefix == "" {
		return local
	}
	return prefix + ":" + local
}

func escapeText(s string) string {
	var b []byte
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '&':
			b = append(b, "&amp;"...)
		case '<':
			b = append(b, "&lt;"...)
		case '>':
			b = append(b, "&gt;"...)
		case '\r':
			b = append(b, "&#xD;"...)
		default:
			b = append(b, s[i])
		}
	}
	return string(b)
}

func escapeAttr(s string) string {
	var b []byte
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '&':
			b = append(b, "&amp;"...)
		case '<':
			b = append(b, "&lt;"...)
		case '"':
			b = append(b, "&quot;"...)
		case '\t':
			b = append(b, "&#x9;"...)
		case '\n':
			b = append(b, "&#xA;"...)
		case '\r':
			b = append(b, "&#xD;"...)
		default:
			b = append(b, s[i])
		}
	}
	return string(b)
}

func (s *serializer) flatten() *Output {
	segs := make([]Segment, len(s.segments))
	off := 0
	for i, sb := range s.segments {
		segs[i] = Segment{Offset: off, Len: sb.len, Source: sb.source}
		off += sb.len
	}
	return &Output{Bytes: append([]byte(nil), s.out...), Segments: segs}
}
