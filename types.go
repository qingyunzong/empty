package dataeng

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"time"
)

// EventType 标识浏览器采集侧上报的事件种类。
type EventType string

const (
	// EvRequest 请求行与请求头事件。
	EvRequest EventType = "request"
	// EvResponse 响应状态行与响应头事件，收到即视为记录闭合。
	EvResponse EventType = "response"
	// EvRedirect 重定向链路上的一跳。
	EvRedirect EventType = "redirect"
	// EvRequestBody 请求正文事件，正文通常晚于请求头到达。
	EvRequestBody EventType = "request_body"
	// EvResponseBody 响应正文事件，正文通常晚于响应头到达。
	EvResponseBody EventType = "response_body"
)

// RecordState 是请求记录在归档生命周期内的状态。
type RecordState string

const (
	// StateOpen 已收到部分事件、尚未闭合的记录。
	StateOpen RecordState = "open"
	// StateComplete 已收到响应事件、正常闭合的记录。
	StateComplete RecordState = "complete"
	// StateSealed run 封闭时仍未闭合，被固化进基础世代的记录。
	StateSealed RecordState = "sealed"
)

var (
	// ErrNotFound 目标 run、记录或 blob 不存在。
	ErrNotFound = errors.New("dataeng: not found")
	// ErrInvalidEvent 事件缺少必填字段或类型无法识别。
	ErrInvalidEvent = errors.New("dataeng: invalid event")
	// ErrCorruptWAL WAL 帧校验失败或被截断。
	ErrCorruptWAL = errors.New("dataeng: corrupt wal segment")
	// ErrClosed 归档已经 Close，拒绝继续写入。
	ErrClosed = errors.New("dataeng: archive closed")
)

// Event 是采集侧上报的单条事件。事件允许乱序到达：同一 (Run, Target,
// RequestID) 的事件会被归并到同一条 Record。
//
// 正文事件可以直接携带 Body 字节（由组件计算摘要并落盘），也可以只携带
// BlobAlgo/BlobDigest 引用外部已存好的 blob。
type Event struct {
	// ID 是幂等键。为空时组件根据事件内容确定性派生，重放会得到相同 ID。
	ID string `json:"id,omitempty"`

	Type      EventType `json:"type"`
	Run       string    `json:"run"`
	Target    string    `json:"target"`
	RequestID string    `json:"request_id"`

	// Timestamp 是浏览器侧观测时间；Seq 是采集侧单调序号，用于稳定排序。
	Timestamp time.Time `json:"timestamp,omitempty"`
	Seq       int64     `json:"seq,omitempty"`

	// Fields 承载类型相关字段（method、url、status、headers 等），未知字段原样透传。
	Fields map[string]any `json:"fields,omitempty"`

	// Body 正文原始字节；仅正文事件使用。
	Body []byte `json:"body,omitempty"`

	// Blob* 在正文已外部落盘时使用，或由组件写入 blob 后回填。
	BlobAlgo   string `json:"blob_algo,omitempty"`
	BlobDigest string `json:"blob_digest,omitempty"`
	BlobSize   int64  `json:"blob_size,omitempty"`
	BlobMIME   string `json:"blob_mime,omitempty"`
}

func (ev Event) validate() error {
	if ev.Run == "" || ev.Target == "" || ev.RequestID == "" {
		return ErrInvalidEvent
	}
	switch ev.Type {
	case EvRequest, EvResponse, EvRedirect, EvRequestBody, EvResponseBody:
	default:
		return ErrInvalidEvent
	}
	if (ev.Type == EvRequestBody || ev.Type == EvResponseBody) &&
		len(ev.Body) == 0 && ev.BlobDigest == "" {
		return ErrInvalidEvent
	}
	return nil
}

// deriveEventID 对除 ID 外的全部内容做确定性哈希，保证同一事件重放后 ID 不变。
func deriveEventID(ev Event) string {
	clone := ev
	clone.ID = ""
	body := clone.Body
	clone.Body = nil
	h := sha256.New()
	b, _ := json.Marshal(struct {
		Event
		BodySHA256 string `json:"body_sha256,omitempty"`
	}{
		Event:      clone,
		BodySHA256: sha256Hex(body),
	})
	h.Write(b)
	return hex.EncodeToString(h.Sum(nil))
}

func sha256Hex(data []byte) string {
	if len(data) == 0 {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// NameValuePair 是 HAR 风格的名值对（头、Cookie、查询串）。
type NameValuePair struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// RequestInfo 是请求字段的类型化视图，由 Record.RequestFields 解码得到。
type RequestInfo struct {
	Method       string          `json:"method"`
	URL          string          `json:"url"`
	HTTPVersion  string          `json:"httpVersion,omitempty"`
	Headers      []NameValuePair `json:"headers,omitempty"`
	Cookies      []NameValuePair `json:"cookies,omitempty"`
	QueryString  []NameValuePair `json:"queryString,omitempty"`
	PostDataMIME string          `json:"postDataMIME,omitempty"`
	HeadersSize  int             `json:"headersSize,omitempty"`
	BodySize     int64           `json:"bodySize,omitempty"`
	Extra        map[string]any  `json:"extra,omitempty"`
}

// ResponseInfo 是响应字段的类型化视图。
type ResponseInfo struct {
	Status      int             `json:"status"`
	StatusText  string          `json:"statusText,omitempty"`
	HTTPVersion string          `json:"httpVersion,omitempty"`
	Headers     []NameValuePair `json:"headers,omitempty"`
	Cookies     []NameValuePair `json:"cookies,omitempty"`
	ContentMIME string          `json:"mimeType,omitempty"`
	ContentSize int64           `json:"contentSize,omitempty"`
	RedirectURL string          `json:"redirectURL,omitempty"`
	HeadersSize int             `json:"headersSize,omitempty"`
	BodySize    int64           `json:"bodySize,omitempty"`
	Extra       map[string]any  `json:"extra,omitempty"`
}

// Redirect 是重定向链上的一跳，按 (Seq, 到达次序) 稳定排序。
type Redirect struct {
	Status  int             `json:"status"`
	From    string          `json:"from,omitempty"`
	To      string          `json:"to"`
	Headers []NameValuePair `json:"headers,omitempty"`
	Seq     int64           `json:"seq,omitempty"`
	Arrival int64           `json:"arrival"`
	At      time.Time       `json:"at,omitempty"`
}

// BlobRef 是一条独立的 blob 来源关系。相同摘要的 blob 只存一份数据，
// 但每个 (Run, Target, RequestID, Role, EventID) 各有一条独立引用。
type BlobRef struct {
	Algo      string    `json:"algo"`
	Digest    string    `json:"digest"`
	Size      int64     `json:"size"`
	MIME      string    `json:"mime,omitempty"`
	Role      string    `json:"role"` // request | response
	Run       string    `json:"run"`
	Target    string    `json:"target"`
	RequestID string    `json:"request_id"`
	EventID   string    `json:"event_id"`
	CreatedAt time.Time `json:"created_at,omitempty"`
}

// Record 是一条请求在当前世代的完整归并快照。
type Record struct {
	Run       string      `json:"run"`
	Target    string      `json:"target"`
	RequestID string      `json:"request_id"`
	State     RecordState `json:"state"`

	// Seq 取首个事件的源序号；Arrival 取归档内单调到达次序，用于稳定排序。
	Seq     int64 `json:"seq"`
	Arrival int64 `json:"arrival"`

	StartedAt   time.Time `json:"started_at,omitempty"`
	CompletedAt time.Time `json:"completed_at,omitempty"`

	// Rev 为当前修订世代号（0 为基础世代）；History 记录本记录经历过的世代。
	Rev     int64   `json:"rev"`
	History []int64 `json:"history,omitempty"`

	RequestFields  map[string]any `json:"request_fields,omitempty"`
	ResponseFields map[string]any `json:"response_fields,omitempty"`
	Redirects      []Redirect     `json:"redirects,omitempty"`

	ReqBody  *BlobRef `json:"req_body,omitempty"`
	RespBody *BlobRef `json:"resp_body,omitempty"`

	// AppliedEvents 是归并到本记录的事件 ID 序列（乱序保留到达次序）。
	AppliedEvents []string `json:"applied_events,omitempty"`
}

// Request 解码请求字段视图。
func (r *Record) Request() *RequestInfo { return decodeRequest(r.RequestFields) }

// Response 解码响应字段视图，记录未收到响应时返回 nil。
func (r *Record) Response() *ResponseInfo {
	if len(r.ResponseFields) == 0 {
		return nil
	}
	return decodeResponse(r.ResponseFields)
}

// PendingItem 是下游尚未发布的一个世代单元。
type PendingItem struct {
	// Key 是发布幂等键，与发布账本中的记录一一对应。
	Key string `json:"key"`
	// Kind 为 "record"（基础世代）或 "revision"（修订世代）。
	Kind string `json:"kind"`

	Run       string `json:"run"`
	Target    string `json:"target"`
	RequestID string `json:"request_id"`
	Rev       int64  `json:"rev"`
	Record    Record `json:"record"`
}

// RunSummary 是 run 封闭时的汇总信息。
type RunSummary struct {
	Run         string    `json:"run"`
	State       string    `json:"state"`
	RecordCount int       `json:"record_count"`
	Complete    int       `json:"complete"`
	SealedOpen  int       `json:"sealed_open"`
	RevisionSeq int64     `json:"revision_seq"`
	SealedAt    time.Time `json:"sealed_at,omitempty"`
}
