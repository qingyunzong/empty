// Package maildata 提供邮件数据入口：把原始 RFC822 邮件解析为
// 附件实体归并组件（merge 包）可直接消费的 Entry 结构。
//
// 解析规则：
//   - 每封邮件（含 message/rfc822 嵌套的转发邮件）生成一个 Entry，
//     顶层 Depth 为 0，每嵌套一层 Depth 加一；
//   - 每个 Entry 拥有全局唯一的 ScopeID，其内部每个 multipart/related
//     再分配独立作用域标识，保证 cid 只在对应 related 作用域内解析，
//     嵌套邮件之间互不串联。
package maildata

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"regexp"
	"strings"
)

// Attachment 是邮件中一个附件/内嵌部件的归一化表示。
type Attachment struct {
	ContentID    string   // 归一化后的 Content-ID（去掉尖括号与空白）
	Filename     string   // 文件名（Content-Disposition filename 或 Content-Type name）
	ContentType  string   // 部件媒体类型
	Inline       bool     // 是否内嵌部件
	Data         []byte   // 按 Content-Transfer-Encoding 解码后的内容
	Digest       string   // 内容摘要（sha256 hex）
	RelatedScope string   // 所属 multipart/related 作用域标识；不在 related 中为空
	CidRefs      []string // 同一 related 作用域内 HTML 正文以 cid: 引用的标识列表
	Depth        int      // 转发/嵌套层级，顶层邮件为 0
}

// Entry 是一封邮件实例的入口数据，可直接交给归并组件消费。
type Entry struct {
	MessageID   string // 归一化后的 Message-Id
	ParentID    string // 外层邮件 Message-Id（嵌套邮件时非空）
	Subject     string
	From        string
	Depth       int // 转发/嵌套层级，顶层为 0
	ScopeID     string
	Attachments []*Attachment
}

var cidRefPattern = regexp.MustCompile(`cid:([^\s"'<>()]+)`)

// Parse 解析原始邮件，返回扁平化的 Entry 列表：顶层邮件在前，
// 其后按出现顺序跟随各嵌套（转发）邮件。
func Parse(raw []byte) ([]*Entry, error) {
	p := &parser{}
	if err := p.parseMessage(raw, 0, ""); err != nil {
		return nil, err
	}
	return p.entries, nil
}

type parser struct {
	entries []*Entry
	seq     int
}

func (p *parser) nextID(prefix string) string {
	p.seq++
	return fmt.Sprintf("%s%d", prefix, p.seq)
}

func (p *parser) parseMessage(raw []byte, depth int, parentID string) error {
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err != nil {
		return fmt.Errorf("maildata: 解析邮件失败: %w", err)
	}
	entry := &Entry{
		MessageID: normalizeCID(msg.Header.Get("Message-Id")),
		ParentID:  parentID,
		Subject:   msg.Header.Get("Subject"),
		From:      msg.Header.Get("From"),
		Depth:     depth,
		ScopeID:   p.nextID("m"),
	}
	p.entries = append(p.entries, entry)

	mediaType, params, err := mime.ParseMediaType(msg.Header.Get("Content-Type"))
	if err != nil || !strings.HasPrefix(mediaType, "multipart/") {
		return nil // 非 multipart 的邮件体不产生附件
	}
	scope := ""
	if mediaType == "multipart/related" {
		// 邮件体顶层即为 related 时同样分配独立作用域。
		scope = entry.ScopeID + "/" + p.nextID("r")
	}
	parts, err := readParts(multipart.NewReader(msg.Body, params["boundary"]))
	if err != nil {
		return err
	}
	return p.processParts(parts, entry, scope)
}

// rawPart 是缓冲在内存中的 MIME 部件（未按传输编码解码）。
type rawPart struct {
	header textproto.MIMEHeader
	data   []byte
}

func readParts(mr *multipart.Reader) ([]*rawPart, error) {
	var parts []*rawPart
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			return parts, nil
		}
		if err != nil {
			return nil, fmt.Errorf("maildata: 读取 MIME 部件失败: %w", err)
		}
		data, err := io.ReadAll(part)
		if err != nil {
			return nil, fmt.Errorf("maildata: 读取部件内容失败: %w", err)
		}
		parts = append(parts, &rawPart{header: part.Header, data: data})
	}
}

// processParts 处理同一 multipart 层级下的部件；relatedScope 非空表示
// 当前处于某个 multipart/related 作用域内。
func (p *parser) processParts(parts []*rawPart, entry *Entry, relatedScope string) error {
	cidRefs := collectCidRefs(parts, relatedScope)
	for _, rp := range parts {
		mediaType, params, err := mime.ParseMediaType(rp.header.Get("Content-Type"))
		if err != nil {
			mediaType = ""
		}
		switch {
		case strings.HasPrefix(mediaType, "multipart/"):
			scope := relatedScope
			if mediaType == "multipart/related" {
				// 每个 related 都是独立作用域，嵌套邮件不会继承。
				scope = entry.ScopeID + "/" + p.nextID("r")
			}
			sub, err := readParts(multipart.NewReader(bytes.NewReader(rp.data), params["boundary"]))
			if err != nil {
				return err
			}
			if err := p.processParts(sub, entry, scope); err != nil {
				return err
			}
		case mediaType == "message/rfc822":
			raw, err := decodeBody(rp)
			if err != nil {
				return err
			}
			// 嵌套邮件作为独立 Entry，Depth 加一，cid 作用域随之隔离。
			if err := p.parseMessage(raw, entry.Depth+1, entry.MessageID); err != nil {
				return err
			}
		default:
			att, ok, err := buildAttachment(rp, mediaType, params, relatedScope, cidRefs, entry.Depth)
			if err != nil {
				return err
			}
			if ok {
				entry.Attachments = append(entry.Attachments, att)
			}
		}
	}
	return nil
}

// collectCidRefs 汇总当前 related 作用域内 HTML 正文引用的 cid。
func collectCidRefs(parts []*rawPart, relatedScope string) []string {
	if relatedScope == "" {
		return nil
	}
	seen := map[string]bool{}
	var refs []string
	for _, rp := range parts {
		mediaType, _, err := mime.ParseMediaType(rp.header.Get("Content-Type"))
		if err != nil || mediaType != "text/html" {
			continue
		}
		body, err := decodeBody(rp)
		if err != nil {
			continue
		}
		for _, m := range cidRefPattern.FindAllStringSubmatch(string(body), -1) {
			cid := normalizeCID(m[1])
			if cid != "" && !seen[cid] {
				seen[cid] = true
				refs = append(refs, cid)
			}
		}
	}
	return refs
}

func buildAttachment(rp *rawPart, mediaType string, params map[string]string, relatedScope string, cidRefs []string, depth int) (*Attachment, bool, error) {
	disp, dispParams, _ := mime.ParseMediaType(rp.header.Get("Content-Disposition"))
	filename := dispParams["filename"]
	if filename == "" {
		filename = params["name"]
	}
	cid := normalizeCID(rp.header.Get("Content-Id"))

	isAttachment := disp == "attachment" ||
		(disp == "inline" && (filename != "" || cid != "")) ||
		(relatedScope != "" && cid != "")
	if !isAttachment {
		return nil, false, nil
	}

	data, err := decodeBody(rp)
	if err != nil {
		return nil, false, err
	}
	sum := sha256.Sum256(data)
	return &Attachment{
		ContentID:    cid,
		Filename:     filename,
		ContentType:  mediaType,
		Inline:       disp == "inline" || (disp == "" && cid != ""),
		Data:         data,
		Digest:       hex.EncodeToString(sum[:]),
		RelatedScope: relatedScope,
		CidRefs:      cidRefs,
		Depth:        depth,
	}, true, nil
}

func decodeBody(rp *rawPart) ([]byte, error) {
	switch strings.ToLower(strings.TrimSpace(rp.header.Get("Content-Transfer-Encoding"))) {
	case "base64":
		data, err := io.ReadAll(base64.NewDecoder(base64.StdEncoding, bytes.NewReader(rp.data)))
		if err != nil {
			return nil, fmt.Errorf("maildata: base64 解码失败: %w", err)
		}
		return data, nil
	case "quoted-printable":
		data, err := io.ReadAll(quotedprintable.NewReader(bytes.NewReader(rp.data)))
		if err != nil {
			return nil, fmt.Errorf("maildata: quoted-printable 解码失败: %w", err)
		}
		return data, nil
	default:
		return rp.data, nil
	}
}

func normalizeCID(s string) string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "<")
	s = strings.TrimSuffix(s, ">")
	return strings.TrimSpace(s)
}
