// Package merge 是附件实体归并组件：直接消费 maildata.Entry，
// 联合 MIME Content-ID、文件名、内容摘要、内嵌引用与转发层级，
// 在附件实体之间建立关系。
//
// 核心语义：
//   - 相同内容在不同邮件中共享同一个 Blob（按内容摘要去重），
//     但每次出现都生成独立的附件实体（Entity）；
//   - Content-ID 只在对应 multipart/related 作用域内解析，
//     作用域标识由 maildata 按邮件实例分配，嵌套邮件互不串联。
package merge

import (
	"fmt"
	"sync"

	"example.org/dataeng/q0076/maildata"
)

// RelationKind 标识实体间关系的建立依据。
type RelationKind string

const (
	RelSameContent  RelationKind = "same-content"  // 内容摘要相同且处于同一转发层级
	RelForwardChain RelationKind = "forward-chain" // 内容摘要相同但处于不同转发层级
	RelSameName     RelationKind = "same-name"     // 文件名相同但内容不同
	RelSameCID      RelationKind = "same-cid"      // 同一 related 作用域内 Content-ID 相同
	RelInlineRef    RelationKind = "inline-ref"    // 被同作用域 HTML 正文以 cid: 引用
)

// Relation 描述实体间的一条关系；TargetID 为目标实体 ID，
// inline-ref 关系的目标为 "body:<relatedScope>"，指向引用它的正文。
type Relation struct {
	Kind     RelationKind
	TargetID string
}

// Blob 是按内容摘要去重存储的附件内容，可被多个实体共享。
type Blob struct {
	Digest   string
	Size     int
	RefCount int // 引用该 blob 的实体数量
	Data     []byte
}

// Entity 是附件实体：附件在某一封邮件中的一次出现。
type Entity struct {
	ID           string
	MessageID    string // 所属邮件
	ScopeID      string // 所属邮件实例的作用域前缀
	Depth        int    // 转发/嵌套层级
	Filename     string
	ContentID    string
	ContentType  string
	Digest       string // 内容摘要，指向共享 Blob
	Inline       bool
	RelatedScope string
	Relations    []Relation
}

// Merger 归并组件，并发安全。
type Merger struct {
	mu       sync.Mutex
	seq      int
	blobs    map[string]*Blob
	entities []*Entity
	byDigest map[string][]*Entity
	byName   map[string][]*Entity
	byCID    map[string][]*Entity // key 含 related 作用域，跨作用域的 cid 不会关联
}

func NewMerger() *Merger {
	return &Merger{
		blobs:    map[string]*Blob{},
		byDigest: map[string][]*Entity{},
		byName:   map[string][]*Entity{},
		byCID:    map[string][]*Entity{},
	}
}

// AddEntry 消费一个邮件入口，为其附件创建实体并建立关系，
// 返回本次创建的实体列表。
func (m *Merger) AddEntry(e *maildata.Entry) []*Entity {
	m.mu.Lock()
	defer m.mu.Unlock()

	var created []*Entity
	for _, att := range e.Attachments {
		m.seq++
		ent := &Entity{
			ID:           fmt.Sprintf("att-%d", m.seq),
			MessageID:    e.MessageID,
			ScopeID:      e.ScopeID,
			Depth:        att.Depth,
			Filename:     att.Filename,
			ContentID:    att.ContentID,
			ContentType:  att.ContentType,
			Digest:       att.Digest,
			Inline:       att.Inline,
			RelatedScope: att.RelatedScope,
		}

		// 内容共享：相同摘要只存一份 blob，实体各自独立。
		blob, ok := m.blobs[att.Digest]
		if !ok {
			blob = &Blob{Digest: att.Digest, Size: len(att.Data), Data: att.Data}
			m.blobs[att.Digest] = blob
		}
		blob.RefCount++

		// 内容摘要关系：同层级为 same-content，跨层级为 forward-chain。
		for _, other := range m.byDigest[att.Digest] {
			kind := RelSameContent
			if other.Depth != ent.Depth {
				kind = RelForwardChain
			}
			link(ent, other, kind)
		}
		m.byDigest[att.Digest] = append(m.byDigest[att.Digest], ent)

		// 文件名关系（内容相同的实体已有内容关系，不重复建立）。
		if att.Filename != "" {
			for _, other := range m.byName[att.Filename] {
				if other.Digest != ent.Digest {
					link(ent, other, RelSameName)
				}
			}
			m.byName[att.Filename] = append(m.byName[att.Filename], ent)
		}

		// Content-ID 关系：仅在同一 multipart/related 作用域内解析，
		// 作用域标识由入口按邮件实例分配，嵌套邮件不会串联。
		if att.ContentID != "" && att.RelatedScope != "" {
			key := att.RelatedScope + "\x00" + att.ContentID
			for _, other := range m.byCID[key] {
				link(ent, other, RelSameCID)
			}
			m.byCID[key] = append(m.byCID[key], ent)
		}

		// 内嵌引用：附件的 Content-ID 被同作用域 HTML 正文引用。
		if att.ContentID != "" {
			for _, ref := range att.CidRefs {
				if ref == att.ContentID {
					ent.Relations = append(ent.Relations, Relation{
						Kind:     RelInlineRef,
						TargetID: "body:" + att.RelatedScope,
					})
					break
				}
			}
		}

		m.entities = append(m.entities, ent)
		created = append(created, ent)
	}
	return created
}

func link(a, b *Entity, kind RelationKind) {
	a.Relations = append(a.Relations, Relation{Kind: kind, TargetID: b.ID})
	b.Relations = append(b.Relations, Relation{Kind: kind, TargetID: a.ID})
}

// Blob 按内容摘要查询共享 blob。
func (m *Merger) Blob(digest string) (*Blob, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	blob, ok := m.blobs[digest]
	return blob, ok
}

// Entities 返回全部附件实体（按创建顺序）。
func (m *Merger) Entities() []*Entity {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Entity, len(m.entities))
	copy(out, m.entities)
	return out
}

// Blobs 返回全部共享 blob。
func (m *Merger) Blobs() []*Blob {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Blob, 0, len(m.blobs))
	for _, blob := range m.blobs {
		out = append(out, blob)
	}
	return out
}
