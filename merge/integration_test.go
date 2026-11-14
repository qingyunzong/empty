package merge

import (
	"testing"

	"example.org/dataeng/q0076/maildata"
)

// 端到端：原始邮件（含 multipart/related 内嵌图与 message/rfc822 转发，
// 转发邮件内复用相同 cid 与相同内容）经入口解析后直接归并。
const sampleMail = `Message-Id: <outer@example.com>
Subject: report
Content-Type: multipart/mixed; boundary=mix

--mix
Content-Type: multipart/related; boundary=rel

--rel
Content-Type: text/html; charset=utf-8

<html><body><img src="cid:logo"></body></html>
--rel
Content-Type: image/png
Content-Id: <logo>
Content-Disposition: inline; filename="logo.png"
Content-Transfer-Encoding: base64

aGVsbG8=
--rel--
--mix
Content-Type: message/rfc822

Message-Id: <inner@example.com>
Subject: fwd
Content-Type: multipart/related; boundary=rel2

--rel2
Content-Type: text/html

<img src="cid:logo">
--rel2
Content-Type: image/png
Content-Id: <logo>
Content-Disposition: inline; filename="logo.png"
Content-Transfer-Encoding: base64

aGVsbG8=
--rel2--
--mix--
`

func TestEndToEnd(t *testing.T) {
	entries, err := maildata.Parse([]byte(sampleMail))
	if err != nil {
		t.Fatalf("Parse 失败: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("期望 2 个 Entry，得到 %d", len(entries))
	}

	m := NewMerger()
	for _, e := range entries {
		m.AddEntry(e)
	}

	ents := m.Entities()
	if len(ents) != 2 {
		t.Fatalf("期望 2 个附件实体，得到 %d", len(ents))
	}
	outer, inner := ents[0], ents[1]

	// 相同内容共享 blob，实体独立。
	if len(m.Blobs()) != 1 {
		t.Errorf("相同内容应共享 blob，得到 %d 个", len(m.Blobs()))
	}
	if outer.ID == inner.ID || outer.Digest != inner.Digest {
		t.Error("实体应独立且摘要一致")
	}

	// 转发层级：跨层级的同内容实体建立 forward-chain。
	if !hasRelation(outer, RelForwardChain, inner.ID) {
		t.Error("转发嵌套的同内容附件应建立 forward-chain 关系")
	}

	// cid 不跨 related 作用域串联：内外层 cid 都是 logo，但无 same-cid 关系。
	if hasRelation(outer, RelSameCID, inner.ID) || hasRelation(inner, RelSameCID, outer.ID) {
		t.Error("嵌套邮件的相同 cid 不得串联")
	}

	// 各自被本作用域 HTML 引用。
	if !hasRelation(outer, RelInlineRef, "body:"+outer.RelatedScope) {
		t.Error("外层内嵌图应有 inline-ref 关系")
	}
	if !hasRelation(inner, RelInlineRef, "body:"+inner.RelatedScope) {
		t.Error("内层内嵌图应有 inline-ref 关系")
	}
}
