package maildata

import (
	"testing"
)

// 样例：顶层邮件含 multipart/related（HTML 引用 cid:logo + 内嵌图）、
// 一个普通附件，以及一封 message/rfc822 转发邮件；转发邮件内部也有
// 自己的 multipart/related，使用相同的 cid "logo" 与相同的内容。
const sample = `Message-Id: <outer@example.com>
Subject: report
From: a@example.com
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
Content-Type: application/pdf
Content-Disposition: attachment; filename="doc.pdf"
Content-Transfer-Encoding: base64

aGVsbG8=
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

func parseSample(t *testing.T) []*Entry {
	t.Helper()
	entries, err := Parse([]byte(sample))
	if err != nil {
		t.Fatalf("Parse 失败: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("期望 2 个 Entry（顶层 + 转发），得到 %d", len(entries))
	}
	return entries
}

func TestParseEntriesAndDepth(t *testing.T) {
	entries := parseSample(t)
	outer, inner := entries[0], entries[1]

	if outer.MessageID != "outer@example.com" || outer.Depth != 0 {
		t.Errorf("顶层 Entry 异常: %+v", outer)
	}
	if inner.MessageID != "inner@example.com" || inner.Depth != 1 {
		t.Errorf("嵌套 Entry 异常: %+v", inner)
	}
	if inner.ParentID != outer.MessageID {
		t.Errorf("嵌套 Entry ParentID = %q，期望 %q", inner.ParentID, outer.MessageID)
	}
	if outer.ScopeID == inner.ScopeID {
		t.Errorf("不同邮件实例的 ScopeID 必须不同，均为 %q", outer.ScopeID)
	}
}

func TestAttachmentsAndDigest(t *testing.T) {
	entries := parseSample(t)
	outer, inner := entries[0], entries[1]

	if len(outer.Attachments) != 2 {
		t.Fatalf("顶层期望 2 个附件，得到 %d", len(outer.Attachments))
	}
	if len(inner.Attachments) != 1 {
		t.Fatalf("嵌套期望 1 个附件，得到 %d", len(inner.Attachments))
	}

	var logo *Attachment
	for _, a := range outer.Attachments {
		if a.Filename == "logo.png" {
			logo = a
		}
	}
	if logo == nil {
		t.Fatal("未找到 logo.png")
	}
	if !logo.Inline || logo.ContentID != "logo" {
		t.Errorf("logo.png 应为内嵌且 ContentID=logo: %+v", logo)
	}
	if string(logo.Data) != "hello" {
		t.Errorf("base64 解码错误，内容 = %q", logo.Data)
	}
	// 相同内容（"hello"）在三个附件中摘要一致。
	if outer.Attachments[0].Digest != outer.Attachments[1].Digest ||
		outer.Attachments[0].Digest != inner.Attachments[0].Digest {
		t.Error("相同内容的附件摘要应一致")
	}
	if inner.Attachments[0].Depth != 1 {
		t.Errorf("嵌套附件 Depth = %d，期望 1", inner.Attachments[0].Depth)
	}
}

func TestCidScopeIsolation(t *testing.T) {
	entries := parseSample(t)
	outerLogo := entries[0].Attachments[0]
	innerLogo := entries[1].Attachments[0]

	if outerLogo.RelatedScope == "" || innerLogo.RelatedScope == "" {
		t.Fatal("related 作用域内的内嵌部件应有 RelatedScope")
	}
	if outerLogo.RelatedScope == innerLogo.RelatedScope {
		t.Errorf("嵌套邮件的 related 作用域必须隔离，均为 %q", outerLogo.RelatedScope)
	}
	// 两个作用域的 HTML 都引用了 cid:logo。
	if !contains(outerLogo.CidRefs, "logo") {
		t.Errorf("顶层 related 作用域应收集到 cid 引用 logo: %v", outerLogo.CidRefs)
	}
	if !contains(innerLogo.CidRefs, "logo") {
		t.Errorf("嵌套 related 作用域应收集到 cid 引用 logo: %v", innerLogo.CidRefs)
	}
}

func contains(ss []string, s string) bool {
	for _, v := range ss {
		if v == s {
			return true
		}
	}
	return false
}
