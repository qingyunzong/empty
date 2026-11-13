package dataeng

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha1"
	"encoding/base32"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
)

// makeWARCRecord 生成一条 gzip 压缩的 WARC response 记录字节。
func makeWARCRecord(t *testing.T, url, payload string) []byte {
	t.Helper()
	body := "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n" + payload
	warc := fmt.Sprintf("WARC/1.0\r\nWARC-Type: response\r\nWARC-Target-URI: %s\r\n"+
		"Content-Type: application/http; msgtype=response\r\nContent-Length: %d\r\n\r\n%s\r\n\r\n",
		url, len(body), body)
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	if _, err := zw.Write([]byte(warc)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func digestOfBytes(b []byte) string {
	sum := sha1.Sum(b)
	return base32.StdEncoding.WithPadding(base32.NoPadding).EncodeToString(sum[:])
}

// rangeTransport 在内存中模拟支持 Range 的 WARC 文件服务器，
// 避免沙箱环境下监听端口。
type rangeTransport struct {
	file        []byte
	ignoreRange bool
	shortBody   bool // 声称满足范围，但实际少给字节
}

func (rt *rangeTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	resp := &http.Response{Request: r, Header: make(http.Header)}
	if rt.ignoreRange || r.Header.Get("Range") == "" {
		resp.StatusCode = http.StatusOK
		resp.Status = "200 OK"
		resp.Body = io.NopCloser(bytes.NewReader(rt.file))
		resp.ContentLength = int64(len(rt.file))
		return resp, nil
	}
	var start, end int
	if _, err := fmt.Sscanf(r.Header.Get("Range"), "bytes=%d-%d", &start, &end); err != nil {
		resp.StatusCode = http.StatusRequestedRangeNotSatisfiable
		resp.Status = "416 Range Not Satisfiable"
		resp.Body = io.NopCloser(strings.NewReader("bad range"))
		return resp, nil
	}
	if end >= len(rt.file) {
		end = len(rt.file) - 1
	}
	chunk := rt.file[start : end+1]
	if rt.shortBody && len(chunk) > 5 {
		chunk = chunk[:len(chunk)-5]
	}
	resp.StatusCode = http.StatusPartialContent
	resp.Status = "206 Partial Content"
	resp.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, len(rt.file)))
	resp.Header.Set("Content-Length", strconv.Itoa(len(chunk)))
	resp.Body = io.NopCloser(bytes.NewReader(chunk))
	resp.ContentLength = int64(len(chunk))
	return resp, nil
}

func newFetcher(file []byte, ignoreRange bool) *Fetcher {
	return &Fetcher{
		BaseURL: "http://warc.test",
		Client:  &http.Client{Transport: &rangeTransport{file: file, ignoreRange: ignoreRange}},
	}
}

func newShortFetcher(file []byte) *Fetcher {
	return &Fetcher{
		BaseURL: "http://warc.test",
		Client:  &http.Client{Transport: &rangeTransport{file: file, shortBody: true}},
	}
}

func TestFetchSuccess(t *testing.T) {
	recA := makeWARCRecord(t, "http://example.com/a", "hello A")
	recB := makeWARCRecord(t, "http://example.com/b", "hello B")
	file := append(append([]byte{}, recA...), recB...)

	rec := CDXRecord{
		URL:       "http://example.com/b",
		Status:    "200",
		Digest:    digestOfBytes(recB),
		Offset:    int64(len(recA)),
		Length:    int64(len(recB)),
		Filename:  "crawl/test.warc.gz",
		Timestamp: "20260101000000",
	}
	f := newFetcher(file, false)
	res, err := f.Fetch(context.Background(), rec)
	if err != nil {
		t.Fatalf("Fetch 失败: %v", err)
	}
	if !bytes.Equal(res.Body, recB) {
		t.Fatalf("返回字节与目标记录不一致")
	}
}

func TestFetchRangeIgnored(t *testing.T) {
	recA := makeWARCRecord(t, "http://example.com/a", "hello A")
	recB := makeWARCRecord(t, "http://example.com/b", "hello B")
	file := append(append([]byte{}, recA...), recB...)

	rec := CDXRecord{
		URL: "http://example.com/b", Status: "200",
		Digest: digestOfBytes(recB), Offset: int64(len(recA)), Length: int64(len(recB)),
		Filename: "test.warc.gz", Timestamp: "20260101000000",
	}
	f := newFetcher(file, true) // 忽略 Range，返回 200 整文件
	_, err := f.Fetch(context.Background(), rec)
	if !errors.Is(err, ErrRangeIgnored) {
		t.Fatalf("期望 ErrRangeIgnored, 得到 %v", err)
	}
}

func TestFetchDigestMismatch(t *testing.T) {
	recA := makeWARCRecord(t, "http://example.com/a", "hello A")

	rec := CDXRecord{
		URL: "http://example.com/a", Status: "200",
		Digest: digestOfBytes([]byte("tampered")), Offset: 0, Length: int64(len(recA)),
		Filename: "test.warc.gz", Timestamp: "20260101000000",
	}
	f := newFetcher(recA, false)
	_, err := f.Fetch(context.Background(), rec)
	if !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("期望 ErrDigestMismatch, 得到 %v", err)
	}
}

// 相邻 WARC 记录不得被误认目标：服务端按错误 offset 返回了相邻记录，
// 即使它是一条合法 WARC 记录，也必须因 digest 不符被拒绝。
func TestFetchAdjacentRecordRejected(t *testing.T) {
	recA := makeWARCRecord(t, "http://example.com/a", "hello A")
	recB := makeWARCRecord(t, "http://example.com/b", "hello B")
	file := append(append([]byte{}, recA...), recB...)

	// 目标是 B，但 offset 错指到 A 的起点。
	rec := CDXRecord{
		URL: "http://example.com/b", Status: "200",
		Digest: digestOfBytes(recB), Offset: 0, Length: int64(len(recA)),
		Filename: "test.warc.gz", Timestamp: "20260101000000",
	}
	f := newFetcher(file, false)
	_, err := f.Fetch(context.Background(), rec)
	if !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("期望 ErrDigestMismatch, 得到 %v", err)
	}
}

// digest 被伪造匹配相邻记录时，WARC-Target-URI 校验仍须拒绝。
func TestFetchWrongTargetURIRejected(t *testing.T) {
	recA := makeWARCRecord(t, "http://example.com/a", "hello A")

	rec := CDXRecord{
		URL: "http://example.com/b", Status: "200",
		Digest: digestOfBytes(recA), Offset: 0, Length: int64(len(recA)),
		Filename: "test.warc.gz", Timestamp: "20260101000000",
	}
	f := newFetcher(recA, false)
	_, err := f.Fetch(context.Background(), rec)
	if !errors.Is(err, ErrWrongRecord) {
		t.Fatalf("期望 ErrWrongRecord, 得到 %v", err)
	}
}

func TestFetchLengthMismatch(t *testing.T) {
	recA := makeWARCRecord(t, "http://example.com/a", "hello A")

	rec := CDXRecord{
		URL: "http://example.com/a", Status: "200",
		Digest: digestOfBytes(recA), Offset: 0, Length: int64(len(recA)),
		Filename: "test.warc.gz", Timestamp: "20260101000000",
	}
	f := newShortFetcher(recA)
	_, err := f.Fetch(context.Background(), rec)
	if !errors.Is(err, ErrLengthMismatch) {
		t.Fatalf("期望 ErrLengthMismatch, 得到 %v", err)
	}
}

func TestNewRequestUnfetchableStatus(t *testing.T) {
	f := &Fetcher{BaseURL: "http://x"}
	rec := CDXRecord{Status: "-", Offset: 0, Length: 10, Filename: "f.warc.gz"}
	_, err := f.NewRequest(context.Background(), rec)
	if !errors.Is(err, ErrUnfetchableStatus) {
		t.Fatalf("期望 ErrUnfetchableStatus, 得到 %v", err)
	}
}

func TestRangeHeader(t *testing.T) {
	rec := CDXRecord{Offset: 100, Length: 50}
	if got := rec.RangeHeader(); got != "bytes=100-149" {
		t.Fatalf("RangeHeader = %q", got)
	}
}

func TestParseCDXAndDeduplicate(t *testing.T) {
	cdx := ` CDX N b a m s k r M S V g
com,example)/ 20250102030405 http://example.com/ text/html 200 AAAA - - 100 0 a.warc.gz
com,example)/ 20260102030405 http://example.com/ text/html 200 AAAA - - 100 0 b.warc.gz
com,example)/ 20250602030405 http://example.com/ text/html 200 BBBB - - 200 0 c.warc.gz
com,example)/ 20240102030405 http://example.com/ text/html 200 AAAA - - 100 0 c.warc.gz
`
	recs, err := ParseCDX(strings.NewReader(cdx))
	if err != nil {
		t.Fatalf("ParseCDX: %v", err)
	}
	if len(recs) != 4 {
		t.Fatalf("解析出 %d 条, 期望 4", len(recs))
	}
	if recs[0].Offset != 0 || recs[0].Length != 100 || recs[0].Filename != "a.warc.gz" {
		t.Fatalf("字段解析错误: %+v", recs[0])
	}

	dedup := Deduplicate(recs)
	if len(dedup) != 2 {
		t.Fatalf("去重后 %d 条, 期望 2", len(dedup))
	}
	// digest AAAA 的三条重复项应保留 crawl/time 世代最新者（2026, b.warc.gz）。
	if dedup[0].Digest != "AAAA" || dedup[0].Filename != "b.warc.gz" || dedup[0].Timestamp != "20260102030405" {
		t.Fatalf("未保留最新世代: %+v", dedup[0])
	}
	if dedup[1].Digest != "BBBB" {
		t.Fatalf("BBBB 记录丢失: %+v", dedup[1])
	}
}

func TestParseCDXLineErrors(t *testing.T) {
	if _, err := ParseCDXLine("too few fields"); err == nil {
		t.Fatal("字段不足应报错")
	}
	if _, err := ParseCDXLine("k 20260101000000 u m 200 D - - abc 0 f"); err == nil {
		t.Fatal("非法 length 应报错")
	}
	if _, err := ParseCDXLine("k 20260101000000 u m 200 D - - 0 0 f"); err == nil {
		t.Fatal("length 为 0 应报错")
	}
}
