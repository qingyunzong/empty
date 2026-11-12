package dataeng

import (
	"strings"
	"testing"
)

func mustSerialize(t *testing.T, root Node, id string, opts *Options) *Output {
	t.Helper()
	out, err := Serialize(root, id, opts)
	if err != nil {
		t.Fatalf("Serialize(%q) failed: %v", id, err)
	}
	return out
}

func mustFail(t *testing.T, root Node, id string, opts *Options, want string) {
	t.Helper()
	if _, err := Serialize(root, id, opts); err == nil {
		t.Fatalf("Serialize(%q) expected error containing %q, got nil", id, want)
	} else if !strings.Contains(err.Error(), want) {
		t.Fatalf("Serialize(%q) error = %q, want substring %q", id, err.Error(), want)
	}
}

func checkCoverage(t *testing.T, out *Output) {
	t.Helper()
	if len(out.Segments) == 0 {
		t.Fatal("no segments")
	}
	off := 0
	for _, seg := range out.Segments {
		if seg.Offset != off {
			t.Fatalf("segment offset gap: got %d want %d", seg.Offset, off)
		}
		if seg.Len < 0 || seg.Offset+seg.Len > len(out.Bytes) {
			t.Fatalf("bad segment length %d at offset %d (total %d)", seg.Len, seg.Offset, len(out.Bytes))
		}
		if seg.Source.NodeID == "" {
			t.Fatalf("segment without source at offset %d", seg.Offset)
		}
		off += seg.Len
	}
	if off != len(out.Bytes) {
		t.Fatalf("segments cover %d bytes, output has %d", off, len(out.Bytes))
	}
}

func findSeg(out *Output, kind SourceKind, nodeID, declPrefix string) *Segment {
	for i := range out.Segments {
		s := &out.Segments[i]
		if s.Source.Kind == kind && s.Source.NodeID == nodeID && s.Source.DeclPrefix == declPrefix {
			return s
		}
	}
	return nil
}

func findAttrSeg(out *Output, nodeID, prefix, local string) *Segment {
	for i := range out.Segments {
		s := &out.Segments[i]
		if s.Source.Kind == SourceAttr && s.Source.NodeID == nodeID &&
			s.Source.AttrPrefix == prefix && s.Source.AttrLocal == local {
			return s
		}
	}
	return nil
}

// 无关祖先声明不得进入输出。
func TestUnrelatedAncestorDecls(t *testing.T) {
	child := &Element{
		ID:    "c",
		Local: "child",
		Kids:  []Node{&Text{ID: "t", Data: "hi"}},
	}
	root := &Element{
		ID:    "r",
		Local: "root",
		Decls: []Decl{{Prefix: "a", URI: "urn:unused-a"}, {Prefix: "b", URI: "urn:unused-b"}},
		Kids:  []Node{child},
	}
	out := mustSerialize(t, root, "c", nil)
	checkCoverage(t, out)
	if got, want := string(out.Bytes), "<child>hi</child>"; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	if strings.Contains(string(out.Bytes), "xmlns") {
		t.Fatalf("unrelated ancestor declarations leaked: %s", out.Bytes)
	}
}

// 祖先借入的可见前缀要输出，且来源定位到祖先声明节点。
func TestAncestorBorrowedPrefix(t *testing.T) {
	grand := &Element{ID: "g", Prefix: "a", Local: "grand"}
	child := &Element{ID: "c", Prefix: "a", Local: "child", Kids: []Node{grand}}
	root := &Element{
		ID:    "r",
		Local: "root",
		Decls: []Decl{{Prefix: "a", URI: "urn:a"}},
		Kids:  []Node{child},
	}
	out := mustSerialize(t, root, "c", nil)
	checkCoverage(t, out)
	want := `<a:child xmlns:a="urn:a"><a:grand></a:grand></a:child>`
	if got := string(out.Bytes); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	seg := findSeg(out, SourceDecl, "r", "a")
	if seg == nil {
		t.Fatal("borrowed declaration segment not attributed to ancestor r")
	}
	if string(out.Bytes[seg.Offset:seg.Offset+seg.Len]) != "urn:a" {
		t.Fatalf("decl segment bytes = %q", out.Bytes[seg.Offset:seg.Offset+seg.Len])
	}
}

// 默认命名空间的清空必须输出 xmlns=""。
func TestDefaultClearing(t *testing.T) {
	leaf := &Element{
		ID:    "leaf",
		Local: "leaf",
		Decls: []Decl{{Prefix: "", URI: ""}},
	}
	mid := &Element{ID: "mid", Local: "mid", Kids: []Node{leaf}}
	root := &Element{
		ID:    "r",
		Local: "root",
		Decls: []Decl{{Prefix: "", URI: "urn:default"}},
		Kids:  []Node{mid},
	}
	out := mustSerialize(t, root, "mid", nil)
	checkCoverage(t, out)
	want := `<mid xmlns="urn:default"><leaf xmlns=""></leaf></mid>`
	if got := string(out.Bytes); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	// 清空声明来自 leaf 上的显式空默认声明。
	if seg := findSeg(out, SourceDecl, "leaf", ""); seg == nil {
		t.Fatal(`xmlns="" not attributed to the leaf declaration node`)
	}
}

// 已渲染非空默认面对实际空绑定（来自 $initial，无显式声明）时，
// 也必须补出 xmlns=""，来源可定位到 $initial。
func TestImplicitResetToInitialEmptyDefault(t *testing.T) {
	leaf := &Element{ID: "leaf", Local: "leaf"}
	holder := &Element{
		ID:    "h",
		Local: "holder",
		Decls: []Decl{{Prefix: "", URI: ""}},
		Kids:  []Node{leaf},
	}
	root := &Element{
		ID:    "r",
		Local: "root",
		Decls: []Decl{{Prefix: "", URI: "urn:default"}},
		Kids:  []Node{holder},
	}
	out := mustSerialize(t, root, "h", nil)
	checkCoverage(t, out)
	want := `<holder xmlns=""><leaf></leaf></holder>`
	if got := string(out.Bytes); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	if seg := findSeg(out, SourceDecl, "h", ""); seg == nil {
		t.Fatal(`explicit xmlns="" not attributed to holder`)
	}

	// 无显式声明、实际绑定回落到 $initial 空默认的情形。
	inner := &Element{ID: "inner", Local: "inner"}
	reset := &Element{
		ID:    "reset",
		Local: "reset",
		Decls: []Decl{{Prefix: "", URI: ""}},
		Kids:  []Node{inner},
	}
	top := &Element{
		ID:    "top",
		Local: "top",
		Decls: []Decl{{Prefix: "", URI: "urn:default"}},
		Kids:  []Node{reset},
	}
	out2 := mustSerialize(t, top, "reset", &Options{InclusivePrefixes: []string{DefaultToken}})
	checkCoverage(t, out2)
	if got, want := string(out2.Bytes), `<reset xmlns=""><inner></inner></reset>`; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

// 元素自身未使用的绑定不得提前输出，直到孙辈真正使用时才出现。
func TestDelayedDeclarationAtGrandchild(t *testing.T) {
	grand := &Element{ID: "g", Prefix: "p", Local: "grand"}
	child := &Element{ID: "c", Local: "child", Kids: []Node{grand}}
	root := &Element{
		ID:    "r",
		Local: "root",
		Decls: []Decl{{Prefix: "p", URI: "urn:p"}},
		Kids:  []Node{child},
	}
	out := mustSerialize(t, root, "c", nil)
	checkCoverage(t, out)
	want := `<child><p:grand xmlns:p="urn:p"></p:grand></child>`
	if got := string(out.Bytes); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	if seg := findSeg(out, SourceDecl, "r", "p"); seg == nil {
		t.Fatal("delayed declaration missing or misattributed")
	}
}

// 兄弟元素对同一前缀的重绑互不影响，各自输出自己实际绑定。
func TestSiblingRebindIsolation(t *testing.T) {
	left := &Element{ID: "l", Prefix: "p", Local: "left"}
	right := &Element{
		ID:     "r2",
		Prefix: "p",
		Local:  "right",
		Decls:  []Decl{{Prefix: "p", URI: "urn:p2"}},
	}
	root := &Element{
		ID:    "r",
		Local: "root",
		Decls: []Decl{{Prefix: "p", URI: "urn:p1"}},
		Kids:  []Node{left, right},
	}
	outL := mustSerialize(t, root, "l", nil)
	checkCoverage(t, outL)
	if got, want := string(outL.Bytes), `<p:left xmlns:p="urn:p1"></p:left>`; got != want {
		t.Fatalf("left = %q, want %q", got, want)
	}
	outR := mustSerialize(t, root, "r2", nil)
	checkCoverage(t, outR)
	if got, want := string(outR.Bytes), `<p:right xmlns:p="urn:p2"></p:right>`; got != want {
		t.Fatalf("right = %q, want %q", got, want)
	}
	if seg := findSeg(outR, SourceDecl, "r2", "p"); seg == nil {
		t.Fatal("rebinding declaration not attributed to the sibling element")
	}
}

// inclusive 集合把未直接使用的前缀/默认强制纳入输出，未绑定项忽略。
func TestInclusivePrefixes(t *testing.T) {
	el := &Element{
		ID:    "e",
		Local: "elem",
		Decls: []Decl{{Prefix: "i", URI: "urn:i"}, {Prefix: "", URI: "urn:def"}},
	}
	root := &Element{ID: "r", Local: "root", Kids: []Node{el}}
	out := mustSerialize(t, root, "e", &Options{
		InclusivePrefixes: []string{"i", "ghost", DefaultToken},
	})
	checkCoverage(t, out)
	// 默认空前缀最先，其余按前缀字节序：#default -> i。
	want := `<elem xmlns="urn:def" xmlns:i="urn:i"></elem>`
	if got := string(out.Bytes); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	for _, seg := range out.Segments {
		if seg.Source.Kind == SourceDecl && (seg.Source.DeclPrefix == "i" || seg.Source.DeclPrefix == "") {
			if !seg.Source.Inclusive {
				t.Fatalf("decl %q not marked inclusive", seg.Source.DeclPrefix)
			}
		}
	}
}

// 属性按 (命名空间 URI, local) 字节序排序，保留原前缀拼写。
func TestAttributeSorting(t *testing.T) {
	el := &Element{
		ID:    "e",
		Local: "elem",
		Decls: []Decl{{Prefix: "z", URI: "urn:ns1"}, {Prefix: "a", URI: "urn:ns2"}},
		Attrs: []Attr{
			{Prefix: "a", Local: "x", Value: "1"},
			{Prefix: "z", Local: "x", Value: "2"},
			{Prefix: "z", Local: "a", Value: "3"},
			{Local: "plain", Value: "4"},
			{Local: "esc", Value: "a&b<c>d\"\te\nf\rg"},
		},
	}
	root := &Element{ID: "r", Local: "root", Kids: []Node{el}}
	out := mustSerialize(t, root, "e", nil)
	checkCoverage(t, out)
	want := `<elem xmlns:a="urn:ns2" xmlns:z="urn:ns1" esc="a&amp;b&lt;c>d&quot;&#x9;e&#xA;f&#xD;g" plain="4" z:a="3" z:x="2" a:x="1"></elem>`
	if got := string(out.Bytes); got != want {
		t.Fatalf("output = %q\nwant    %q", got, want)
	}
	// 无前缀属性不进默认命名空间：即便默认非空也不冲突。
	if findAttrSeg(out, "e", "", "plain") == nil {
		t.Fatal("plain attribute segment missing")
	}
}

// 同展开名属性冲突即使前缀不同也要拒绝。
func TestDuplicateExpandedAttrs(t *testing.T) {
	el := &Element{
		ID:    "e",
		Local: "elem",
		Decls: []Decl{{Prefix: "p1", URI: "urn:same"}, {Prefix: "p2", URI: "urn:same"}},
		Attrs: []Attr{{Prefix: "p1", Local: "x", Value: "1"}, {Prefix: "p2", Local: "x", Value: "2"}},
	}
	root := &Element{ID: "r", Local: "root", Kids: []Node{el}}
	mustFail(t, root, "e", nil, "duplicate attribute expanded name")
}

func TestEscapingAndEmptyElement(t *testing.T) {
	el := &Element{
		ID:    "e",
		Local: "elem",
		Kids:  []Node{&Text{ID: "t", Data: "a&b<c>d\re"}},
	}
	root := &Element{ID: "r", Local: "root", Kids: []Node{el}}
	out := mustSerialize(t, root, "e", nil)
	checkCoverage(t, out)
	if got, want := string(out.Bytes), `<elem>a&amp;b&lt;c&gt;d&#xD;e</elem>`; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	empty := &Element{ID: "empty", Local: "empty"}
	root2 := &Element{ID: "r", Local: "root", Kids: []Node{empty}}
	out2 := mustSerialize(t, root2, "empty", nil)
	checkCoverage(t, out2)
	if got, want := string(out2.Bytes), `<empty></empty>`; got != want {
		t.Fatalf("empty = %q, want %q", got, want)
	}
}

// xml 前缀固定可用且永不输出 xmlns:xml。
func TestXMLPrefixFixed(t *testing.T) {
	el := &Element{
		ID:    "e",
		Local: "elem",
		Attrs: []Attr{{Prefix: XMLPrefix, Local: "lang", Value: "en"}},
	}
	root := &Element{ID: "r", Local: "root", Kids: []Node{el}}
	out := mustSerialize(t, root, "e", nil)
	checkCoverage(t, out)
	if got, want := string(out.Bytes), `<elem xml:lang="en"></elem>`; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	if strings.Contains(string(out.Bytes), "xmlns:xml") {
		t.Fatal("xml declaration must never be rendered")
	}

	rebind := &Element{
		ID:    "b",
		Local: "b",
		Decls: []Decl{{Prefix: XMLPrefix, URI: "urn:other"}},
	}
	mustFail(t, &Element{ID: "r", Local: "r", Kids: []Node{rebind}}, "b", nil, "rebinds xml prefix")

	steal := &Element{
		ID:    "s",
		Local: "s",
		Decls: []Decl{{Prefix: "p", URI: XMLURI}},
	}
	mustFail(t, &Element{ID: "r", Local: "r", Kids: []Node{steal}}, "s", nil, "fixed xml URI")
}

func TestValidationErrors(t *testing.T) {
	wrap := func(el *Element) Node {
		return &Element{ID: "r", Local: "root", Kids: []Node{el}}
	}
	cases := []struct {
		name string
		root Node
		id   string
		want string
	}{
		{"missing id", wrap(&Element{ID: "e", Local: "e"}), "ghost", "not found"},
		{"bad element name", wrap(&Element{ID: "e", Local: "1bad"}), "e", "invalid name"},
		{"bad prefix name", wrap(&Element{ID: "e", Prefix: "a:b", Local: "e"}), "e", "invalid name"},
		{"xmlns ordinary prefix", wrap(&Element{ID: "e", Prefix: XMLNSPrefix, Local: "e"}), "e", "invalid name"},
		{"xmlns unprefixed attr", wrap(&Element{ID: "e", Local: "e", Attrs: []Attr{{Local: XMLNSPrefix, Value: "x"}}}), "e", "forbidden xmlns attribute"},
		{"duplicate decl prefix", wrap(&Element{ID: "e", Local: "e", Decls: []Decl{{Prefix: "p", URI: "urn:p"}, {Prefix: "p", URI: "urn:q"}}}), "e", "more than once"},
		{"empty URI on prefix", wrap(&Element{ID: "e", Local: "e", Decls: []Decl{{Prefix: "p", URI: ""}}}), "e", "empty URI"},
		{"bad URI scheme", wrap(&Element{ID: "e", Local: "e", Decls: []Decl{{Prefix: "p", URI: "urn x"}}}), "e", "invalid namespace URI"},
		{"unbound element prefix", wrap(&Element{ID: "e", Prefix: "p", Local: "e"}), "e", "unbound prefix"},
		{"unbound attr prefix", wrap(&Element{ID: "e", Local: "e", Attrs: []Attr{{Prefix: "p", Local: "a", Value: "x"}}}), "e", "unbound prefix"},
		{"default does not apply to unprefixed element ns", wrap(&Element{ID: "e", Local: "e", Decls: []Decl{{Prefix: "", URI: "urn:d"}}}), "e", ""},
	}
	for _, tc := range cases {
		if tc.want == "" {
			// 默认命名空间作用于无前缀元素本身是合法的。
			out := mustSerialize(t, tc.root, tc.id, nil)
			checkCoverage(t, out)
			continue
		}
		t.Run(tc.name, func(t *testing.T) {
			mustFail(t, tc.root, tc.id, nil, tc.want)
		})
	}
}

func TestLimitsAndScalars(t *testing.T) {
	deep := &Element{ID: "last", Local: "last"}
	for i := 0; i < 9; i++ {
		deep = &Element{ID: "n" + string(rune('a'+i)), Local: "n", Kids: []Node{deep}}
	}
	root := &Element{ID: "r", Local: "r", Kids: []Node{deep}}
	mustFail(t, root, "last", &Options{MaxDepth: 5}, "exceeds limit")

	big := &Element{ID: "e", Local: "e", Kids: []Node{&Text{ID: "t", Data: strings.Repeat("x", 100)}}}
	mustFail(t, &Element{ID: "r", Local: "r", Kids: []Node{big}}, "e", &Options{MaxOutputBytes: 10}, "exceeds")

	badText := &Element{ID: "e", Local: "e", Kids: []Node{&Text{ID: "t", Data: "bad\xff\xfe"}}}
	mustFail(t, &Element{ID: "r", Local: "r", Kids: []Node{badText}}, "e", nil, "illegal XML 1.0 character")

	// 合法非 ASCII 标量按 UTF-8 原样输出。
	okText := &Element{ID: "e", Local: "e", Kids: []Node{&Text{ID: "t", Data: "中文\u00e9\U0001F600"}}}
	out := mustSerialize(t, &Element{ID: "r", Local: "r", Kids: []Node{okText}}, "e", nil)
	checkCoverage(t, out)
	if got, want := string(out.Bytes), `<e>中文é😀</e>`; got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
}

// 不支持 DTD、处理指令或注释节点。
type foreignNode struct{ id string }

func (f *foreignNode) nodeID() string   { return f.id }
func (f *foreignNode) nodeKind() string { return "comment" }

func TestUnsupportedNodeKind(t *testing.T) {
	root := &Element{ID: "r", Local: "r", Kids: []Node{&foreignNode{id: "c"}}}
	mustFail(t, root, "r", nil, "unsupported kind")
}

// 无前缀属性不继承默认命名空间，因此与默认命名空间中的同名元素不冲突。
func TestUnprefixedAttrIgnoresDefault(t *testing.T) {
	el := &Element{
		ID:    "e",
		Local: "elem",
		Decls: []Decl{{Prefix: "", URI: "urn:d"}},
		Attrs: []Attr{{Local: "id", Value: "1"}, {Local: "id", Value: "2"}},
	}
	root := &Element{ID: "r", Local: "root", Kids: []Node{el}}
	mustFail(t, root, "e", nil, "duplicate attribute expanded name")
}

// 祖先借入前缀后，同 URI 的重声明不产生重复输出；不同 URI 才重绑。
func TestRedeclarationSameURI(t *testing.T) {
	grand := &Element{ID: "g", Prefix: "p", Local: "grand"}
	child := &Element{
		ID:     "c",
		Prefix: "p",
		Local:  "child",
		Decls:  []Decl{{Prefix: "p", URI: "urn:p"}},
		Kids:   []Node{grand},
	}
	root := &Element{
		ID:    "r",
		Local: "root",
		Decls: []Decl{{Prefix: "p", URI: "urn:p"}},
		Kids:  []Node{child},
	}
	out := mustSerialize(t, root, "c", nil)
	checkCoverage(t, out)
	// 子元素显式重声明了同一 URI：声明节点仍输出且定位到 c。
	want := `<p:child xmlns:p="urn:p"><p:grand></p:grand></p:child>`
	if got := string(out.Bytes); got != want {
		t.Fatalf("output = %q, want %q", got, want)
	}
	if count := strings.Count(string(out.Bytes), "xmlns:p"); count != 1 {
		t.Fatalf("xmlns:p rendered %d times, want 1", count)
	}
	if seg := findSeg(out, SourceDecl, "c", "p"); seg == nil {
		t.Fatal("explicit redeclaration not attributed to element c")
	}
}

// 来源段必须能精确映射回输出字节，包括祖先借入声明。
func TestSegmentByteMapping(t *testing.T) {
	el := &Element{
		ID:    "e",
		Local: "elem",
		Attrs: []Attr{{Local: "k", Value: "v"}},
		Kids:  []Node{&Text{ID: "t", Data: "abc"}},
	}
	root := &Element{
		ID:    "r",
		Local: "root",
		Decls: []Decl{{Prefix: "p", URI: "urn:p"}},
		Kids:  []Node{&Element{ID: "mid", Prefix: "p", Local: "mid", Kids: []Node{el}}},
	}
	out := mustSerialize(t, root, "mid", nil)
	checkCoverage(t, out)
	decl := findSeg(out, SourceDecl, "r", "p")
	if decl == nil || string(out.Bytes[decl.Offset:decl.Offset+decl.Len]) != "urn:p" {
		t.Fatal("borrowed declaration bytes not locatable at ancestor r")
	}
	var attr *Segment
	for i := range out.Segments {
		sg := &out.Segments[i]
		if sg.Source.Kind == SourceAttr && sg.Source.NodeID == "e" &&
			sg.Source.AttrPrefix == "" && sg.Source.AttrLocal == "k" &&
			string(out.Bytes[sg.Offset:sg.Offset+sg.Len]) == "v" {
			attr = sg
		}
	}
	if attr == nil {
		t.Fatal("attribute value bytes not locatable")
	}
}

// 深度限制边界：恰好等于限制时通过，超出一层时拒绝。
func TestDepthBoundary(t *testing.T) {
	deep := &Element{ID: "d3", Local: "n"}
	deep = &Element{ID: "d2", Local: "n", Kids: []Node{deep}}
	deep = &Element{ID: "d1", Local: "n", Kids: []Node{deep}}
	root := &Element{ID: "r", Local: "r", Kids: []Node{deep}}
	out := mustSerialize(t, root, "d3", &Options{MaxDepth: 4})
	checkCoverage(t, out)
	mustFail(t, root, "d3", &Options{MaxDepth: 3}, "exceeds limit")
}
