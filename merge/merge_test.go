package merge

import (
	"testing"

	"example.org/dataeng/q0076/maildata"
)

func att(digest, filename, cid, scope string, depth int, refs ...string) *maildata.Attachment {
	return &maildata.Attachment{
		ContentID:    cid,
		Filename:     filename,
		Digest:       digest,
		Data:         []byte(digest),
		RelatedScope: scope,
		CidRefs:      refs,
		Depth:        depth,
	}
}

func entry(msgID, scopeID string, depth int, atts ...*maildata.Attachment) *maildata.Entry {
	return &maildata.Entry{MessageID: msgID, ScopeID: scopeID, Depth: depth, Attachments: atts}
}

func hasRelation(ent *Entity, kind RelationKind, targetID string) bool {
	for _, r := range ent.Relations {
		if r.Kind == kind && r.TargetID == targetID {
			return true
		}
	}
	return false
}

func findByFilename(ents []*Entity, name string) *Entity {
	for _, e := range ents {
		if e.Filename == name {
			return e
		}
	}
	return nil
}

// 相同内容在不同邮件中共享 blob，但附件实体各自独立。
func TestSharedBlobIndependentEntities(t *testing.T) {
	m := NewMerger()
	m.AddEntry(entry("m1", "s1", 0, att("digest-a", "a.png", "", "", 0)))
	m.AddEntry(entry("m2", "s2", 0, att("digest-a", "a.png", "", "", 0)))

	ents := m.Entities()
	if len(ents) != 2 {
		t.Fatalf("期望 2 个独立实体，得到 %d", len(ents))
	}
	if ents[0].ID == ents[1].ID {
		t.Fatal("实体 ID 必须唯一")
	}
	blob, ok := m.Blob("digest-a")
	if !ok {
		t.Fatal("缺少共享 blob")
	}
	if blob.RefCount != 2 {
		t.Errorf("blob RefCount = %d，期望 2", blob.RefCount)
	}
	if len(m.Blobs()) != 1 {
		t.Errorf("相同内容应只存一份 blob，得到 %d", len(m.Blobs()))
	}
	if !hasRelation(ents[0], RelSameContent, ents[1].ID) ||
		!hasRelation(ents[1], RelSameContent, ents[0].ID) {
		t.Error("同内容同层级的实体应建立双向 same-content 关系")
	}
}

// 相同内容出现在不同转发层级时建立 forward-chain 关系。
func TestForwardChainAcrossDepths(t *testing.T) {
	m := NewMerger()
	m.AddEntry(entry("outer", "s1", 0, att("digest-a", "a.png", "", "", 0)))
	m.AddEntry(entry("inner", "s2", 1, att("digest-a", "a.png", "", "", 1)))

	ents := m.Entities()
	if !hasRelation(ents[0], RelForwardChain, ents[1].ID) {
		t.Error("跨转发层级的同内容实体应建立 forward-chain 关系")
	}
	if hasRelation(ents[0], RelSameContent, ents[1].ID) {
		t.Error("跨层级不应标记为 same-content")
	}
}

// cid 只在对应 multipart/related 作用域内解析：相同 cid 出现在
// 不同作用域（含嵌套邮件）不产生 same-cid 关系；同作用域才关联。
func TestCidScopedResolution(t *testing.T) {
	m := NewMerger()
	m.AddEntry(entry("m1", "s1", 0,
		att("d1", "x.png", "logo", "s1/r1", 0),
		att("d2", "y.png", "logo", "s1/r1", 0),
	))
	m.AddEntry(entry("m2", "s2", 1,
		att("d3", "z.png", "logo", "s2/r1", 0),
	))

	x := findByFilename(m.Entities(), "x.png")
	y := findByFilename(m.Entities(), "y.png")
	z := findByFilename(m.Entities(), "z.png")

	if !hasRelation(x, RelSameCID, y.ID) || !hasRelation(y, RelSameCID, x.ID) {
		t.Error("同一 related 作用域内相同 cid 应建立 same-cid 关系")
	}
	if hasRelation(x, RelSameCID, z.ID) || hasRelation(z, RelSameCID, x.ID) ||
		hasRelation(y, RelSameCID, z.ID) || hasRelation(z, RelSameCID, y.ID) {
		t.Error("嵌套邮件的相同 cid 不得跨作用域串联")
	}
}

// 内嵌引用：附件 cid 被同作用域 HTML 引用时建立 inline-ref 关系。
func TestInlineRefRelation(t *testing.T) {
	m := NewMerger()
	m.AddEntry(entry("m1", "s1", 0,
		att("d1", "logo.png", "logo", "s1/r1", 0, "logo", "banner"),
	))

	ent := findByFilename(m.Entities(), "logo.png")
	if !hasRelation(ent, RelInlineRef, "body:s1/r1") {
		t.Errorf("被 HTML 引用的内嵌附件应建立 inline-ref 关系: %+v", ent.Relations)
	}
}

// 文件名相同但内容不同的实体建立 same-name 关系。
func TestSameNameRelation(t *testing.T) {
	m := NewMerger()
	m.AddEntry(entry("m1", "s1", 0, att("d1", "doc.pdf", "", "", 0)))
	m.AddEntry(entry("m2", "s2", 0, att("d2", "doc.pdf", "", "", 0)))

	ents := m.Entities()
	if !hasRelation(ents[0], RelSameName, ents[1].ID) {
		t.Error("同名不同内容的实体应建立 same-name 关系")
	}
	if hasRelation(ents[0], RelSameContent, ents[1].ID) {
		t.Error("内容不同不应建立 same-content 关系")
	}
}
