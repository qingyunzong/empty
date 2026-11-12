package streamdl

import (
	"crypto/sha256"
	"net/http"
	"sync"
)

const (
	etagV1 = "\"v1-strong\""
	etagV2 = "\"v2-strong\""
)

// recordedRequest captures the resume-relevant headers of one call.
type recordedRequest struct {
	rangeHdr   string
	ifRangeHdr string
}

// requestLog records every request seen by a test server.
type requestLog struct {
	mu       sync.Mutex
	requests []recordedRequest
}

func (l *requestLog) add(r *http.Request) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.requests = append(l.requests, recordedRequest{
		rangeHdr:   r.Header.Get("Range"),
		ifRangeHdr: r.Header.Get("If-Range"),
	})
}

func (l *requestLog) snapshot() []recordedRequest {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]recordedRequest(nil), l.requests...)
}

// requester turns a pipeServer into a streamdl.Requester.
func requester(server *pipeServer) Requester {
	return pipeRequester(server)
}

func digestOf(data []byte) [sha256.Size]byte {
	return sha256.Sum256(data)
}

func write206(w http.ResponseWriter, r *http.Request, data []byte, etag string, start, end int64) {
	w.Header().Set("ETag", etag)
	w.Header().Set("Content-Range",
		"bytes "+itoa(start)+"-"+itoa(end)+"/"+itoa(int64(len(data))))
	w.Header().Set("Content-Length", itoa(end-start+1))
	w.WriteHeader(http.StatusPartialContent)
	_, _ = w.Write(data[start : end+1])
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
