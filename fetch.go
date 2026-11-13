package dataeng

import (
	"context"
	"crypto/sha1"
	"encoding/base32"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

var (
	// ErrRangeIgnored 表示服务端忽略了 Range 头（未返回 206）。
	ErrRangeIgnored = errors.New("dataeng: 服务端忽略 Range 头")
	// ErrDigestMismatch 表示返回字节范围的 SHA-1 与 CDX digest 不符。
	ErrDigestMismatch = errors.New("dataeng: 字节范围摘要不符")
	// ErrLengthMismatch 表示返回字节数与 CDX length 不符。
	ErrLengthMismatch = errors.New("dataeng: 字节范围长度不符")
	// ErrWrongRecord 表示返回的 WARC 记录并非目标（如相邻记录）。
	ErrWrongRecord = errors.New("dataeng: 返回记录与目标 URI 不符")
	// ErrUnfetchableStatus 表示 CDX status 非 2xx，不应发起请求。
	ErrUnfetchableStatus = errors.New("dataeng: CDX status 非 2xx")
)

// Fetcher 按 CDX 记录协调 WARC 字节范围请求并校验响应。
type Fetcher struct {
	// BaseURL 为 filename 的地址前缀，如 "https://data.commoncrawl.org/"。
	BaseURL string
	// Client 为空时使用 http.DefaultClient。
	Client *http.Client
}

// Result 为一次成功校验的范围读取结果。
type Result struct {
	Record CDXRecord
	Body   []byte // 恰好 Length 字节的原始范围数据
}

// digestOf 计算字节范围的 CDX 风格摘要：base32（无填充、大写）SHA-1。
func digestOf(b []byte) string {
	sum := sha1.Sum(b)
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:])
}

// NewRequest 按记录的 filename、offset、length 构造带 Range 头的请求。
// status 非 2xx 的记录返回 ErrUnfetchableStatus。
func (f *Fetcher) NewRequest(ctx context.Context, rec CDXRecord) (*http.Request, error) {
	if !rec.Fetchable() {
		return nil, fmt.Errorf("%w: status=%q", ErrUnfetchableStatus, rec.Status)
	}
	if rec.Length <= 0 || rec.Offset < 0 {
		return nil, fmt.Errorf("dataeng: 非法范围 offset=%d length=%d", rec.Offset, rec.Length)
	}
	url := strings.TrimRight(f.BaseURL, "/") + "/" + strings.TrimLeft(rec.Filename, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", rec.RangeHeader())
	return req, nil
}

// Fetch 发起范围请求并逐项校验：
//  1. 必须返回 206 Partial Content，否则视为 Range 被忽略（拒绝整文件，
//     防止把 offset 0 处的相邻 WARC 记录误认目标）；
//  2. Content-Range（若提供）必须与请求范围一致；
//  3. 返回字节数必须恰好等于 length；
//  4. 字节范围的 SHA-1 必须与 CDX digest 一致；
//  5. 范围内容必须是目标 URL 的 WARC 记录。
func (f *Fetcher) Fetch(ctx context.Context, rec CDXRecord) (*Result, error) {
	req, err := f.NewRequest(ctx, rec)
	if err != nil {
		return nil, err
	}
	client := f.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusPartialContent {
		return nil, fmt.Errorf("%w: HTTP %d", ErrRangeIgnored, resp.StatusCode)
	}
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		want := fmt.Sprintf("bytes %d-%d/", rec.Offset, rec.Offset+rec.Length-1)
		if !strings.HasPrefix(cr, want) {
			return nil, fmt.Errorf("%w: Content-Range %q, 期望前缀 %q", ErrRangeIgnored, cr, want)
		}
	}

	body := make([]byte, rec.Length)
	if _, err := io.ReadFull(resp.Body, body); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrLengthMismatch, err)
	}
	// 服务端不得返回超出 length 的字节。
	var extra [1]byte
	if n, err := resp.Body.Read(extra[:]); n > 0 || err != io.EOF {
		return nil, fmt.Errorf("%w: 响应体超出 length=%d", ErrLengthMismatch, rec.Length)
	}

	if got := digestOf(body); !strings.EqualFold(got, rec.Digest) {
		return nil, fmt.Errorf("%w: got %s, want %s", ErrDigestMismatch, got, rec.Digest)
	}

	if rec.URL != "" {
		target, err := warcTargetURI(body)
		if err != nil {
			return nil, err
		}
		if target != rec.URL {
			return nil, fmt.Errorf("%w: got %q, want %q", ErrWrongRecord, target, rec.URL)
		}
	}
	return &Result{Record: rec, Body: body}, nil
}
