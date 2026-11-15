package dataeng

import (
	"encoding/json"
	"sort"
	"time"
)

// ExportOptions 控制 HAR 导出形态。
type ExportOptions struct {
	// CreatorName/CreatorVersion 写入 log.creator。
	CreatorName    string
	CreatorVersion string
	// InlineBodies 为 true 时把正文 blob 的字节内联进 postData.text/content.text；
	// 默认 false，只输出 blob 摘要引用，避免导出文件膨胀。
	InlineBodies bool
}

type harFile struct {
	Log harLog `json:"log"`
}

type harLog struct {
	Version string         `json:"version"`
	Creator harCreator     `json:"creator"`
	Pages   []harPage      `json:"pages"`
	Entries []harEntry     `json:"entries"`
	Comment string         `json:"comment,omitempty"`
	Meta    map[string]any `json:"meta,omitempty"`
}

type harCreator struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type harPage struct {
	ID              string `json:"id"`
	StartedDateTime string `json:"startedDateTime,omitempty"`
	Title           string `json:"title,omitempty"`
	Target          string `json:"_target"`
}

type harEntry struct {
	Pageref         string           `json:"pageref,omitempty"`
	StartedDateTime string           `json:"startedDateTime"`
	Time            int64            `json:"time"`
	Request         harRequest       `json:"request"`
	Response        harResponse      `json:"response"`
	Cache           map[string]any   `json:"cache,omitempty"`
	Timings         map[string]int64 `json:"timings,omitempty"`
	ServerIPAddress string           `json:"serverIPAddress,omitempty"`
	Connection      string           `json:"connection,omitempty"`
	Comment         string           `json:"comment,omitempty"`
	State           RecordState      `json:"_state"`
	Rev             int64            `json:"_rev"`
	RequestID       string           `json:"_request_id"`
	Redirects       []Redirect       `json:"_redirects,omitempty"`
}

type harRequest struct {
	Method      string          `json:"method"`
	URL         string          `json:"url"`
	HTTPVersion string          `json:"httpVersion,omitempty"`
	Headers     []NameValuePair `json:"headers"`
	Cookies     []NameValuePair `json:"cookies,omitempty"`
	QueryString []NameValuePair `json:"queryString,omitempty"`
	PostData    *harPostData    `json:"postData,omitempty"`
	HeadersSize int             `json:"headersSize"`
	BodySize    int64           `json:"bodySize"`
	Extra       map[string]any  `json:"-"`
}

type harPostData struct {
	MimeType string      `json:"mimeType,omitempty"`
	Text     string      `json:"text,omitempty"`
	Blob     *harBlobRef `json:"_blob,omitempty"`
}

type harResponse struct {
	Status      int             `json:"status"`
	StatusText  string          `json:"statusText,omitempty"`
	HTTPVersion string          `json:"httpVersion,omitempty"`
	Headers     []NameValuePair `json:"headers"`
	Cookies     []NameValuePair `json:"cookies,omitempty"`
	Content     harContent      `json:"content"`
	RedirectURL string          `json:"redirectURL,omitempty"`
	HeadersSize int             `json:"headersSize"`
	BodySize    int64           `json:"bodySize"`
}

type harContent struct {
	Size     int64       `json:"size"`
	MimeType string      `json:"mimeType,omitempty"`
	Text     string      `json:"text,omitempty"`
	Blob     *harBlobRef `json:"_blob,omitempty"`
}

type harBlobRef struct {
	Algo   string `json:"algo"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
	MIME   string `json:"mime,omitempty"`
}

func blobRefToHAR(ref *BlobRef) *harBlobRef {
	if ref == nil {
		return nil
	}
	return &harBlobRef{Algo: ref.Algo, Digest: ref.Digest, Size: ref.Size, MIME: ref.MIME}
}

// ExportHAR 把 run 的当前记录快照导出为标准 HAR 1.2 文档（JSON 字节）。
// 同一 target 的记录归入一个 page，条目按到达次序排列。
func (a *Archive) ExportHAR(run string, opts ExportOptions) ([]byte, error) {
	records, err := a.ListRecords(run)
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	sealed := false
	if rs, ok := a.runs[run]; ok {
		sealed = rs.meta.Sealed
	}
	a.mu.Unlock()

	log := harLog{
		Version: "1.2",
		Creator: harCreator{
			Name:    orDefault(opts.CreatorName, "dataeng-har-archive"),
			Version: orDefault(opts.CreatorVersion, "1.0"),
		},
		Meta: map[string]any{
			"run":    run,
			"sealed": sealed,
		},
	}

	pageOrder := map[string]int{}
	for _, rec := range records {
		if _, ok := pageOrder[rec.Target]; !ok {
			pageOrder[rec.Target] = len(log.Pages)
			log.Pages = append(log.Pages, harPage{
				ID: rec.Target, Target: rec.Target,
				StartedDateTime: harTime(rec.StartedAt),
			})
		}
		entry, err := a.toHAREntry(run, rec, opts)
		if err != nil {
			return nil, err
		}
		log.Entries = append(log.Entries, entry)
	}
	sort.SliceStable(log.Entries, func(i, j int) bool {
		if log.Entries[i].Pageref != log.Entries[j].Pageref {
			return pageOrder[log.Entries[i].Pageref] < pageOrder[log.Entries[j].Pageref]
		}
		return log.Entries[i].StartedDateTime < log.Entries[j].StartedDateTime
	})
	return json.MarshalIndent(harFile{Log: log}, "", "  ")
}

func (a *Archive) toHAREntry(run string, rec Record, opts ExportOptions) (harEntry, error) {
	reqInfo := rec.Request()
	respInfo := rec.Response()

	harReq := harRequest{Headers: []NameValuePair{}}
	if reqInfo != nil {
		harReq.Method = reqInfo.Method
		harReq.URL = reqInfo.URL
		harReq.HTTPVersion = reqInfo.HTTPVersion
		harReq.Headers = orPairs(reqInfo.Headers)
		harReq.Cookies = reqInfo.Cookies
		harReq.QueryString = reqInfo.QueryString
		harReq.HeadersSize = reqInfo.HeadersSize
		harReq.BodySize = reqInfo.BodySize
	}
	if rec.ReqBody != nil {
		post := &harPostData{MimeType: rec.ReqBody.MIME, Blob: blobRefToHAR(rec.ReqBody)}
		if opts.InlineBodies {
			data, err := a.blobs.Read(rec.ReqBody.Algo, rec.ReqBody.Digest)
			if err != nil {
				return harEntry{}, err
			}
			post.Text = string(data)
		}
		harReq.PostData = post
		if harReq.BodySize == 0 {
			harReq.BodySize = rec.ReqBody.Size
		}
	}

	harResp := harResponse{Headers: []NameValuePair{}, Content: harContent{}}
	if respInfo != nil {
		harResp.Status = respInfo.Status
		harResp.StatusText = respInfo.StatusText
		harResp.HTTPVersion = respInfo.HTTPVersion
		harResp.Headers = orPairs(respInfo.Headers)
		harResp.Cookies = respInfo.Cookies
		harResp.RedirectURL = respInfo.RedirectURL
		harResp.HeadersSize = respInfo.HeadersSize
		harResp.BodySize = respInfo.BodySize
		harResp.Content.MimeType = respInfo.ContentMIME
		harResp.Content.Size = respInfo.ContentSize
	}
	if rec.RespBody != nil {
		harResp.Content.Blob = blobRefToHAR(rec.RespBody)
		if harResp.Content.Size == 0 {
			harResp.Content.Size = rec.RespBody.Size
		}
		if opts.InlineBodies {
			data, err := a.blobs.Read(rec.RespBody.Algo, rec.RespBody.Digest)
			if err != nil {
				return harEntry{}, err
			}
			harResp.Content.Text = string(data)
		}
	}

	var elapsed int64
	if !rec.CompletedAt.IsZero() && !rec.StartedAt.IsZero() {
		elapsed = rec.CompletedAt.Sub(rec.StartedAt).Milliseconds()
	}
	return harEntry{
		Pageref:         rec.Target,
		StartedDateTime: harTime(rec.StartedAt),
		Time:            elapsed,
		Request:         harReq,
		Response:        harResp,
		Timings:         map[string]int64{"total": elapsed},
		State:           rec.State,
		Rev:             rec.Rev,
		RequestID:       rec.RequestID,
		Redirects:       rec.Redirects,
	}, nil
}

func harTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339Nano)
}
func orDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

func orPairs(p []NameValuePair) []NameValuePair {
	if p == nil {
		return []NameValuePair{}
	}
	return p
}
