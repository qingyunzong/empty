package q149

import (
	"io"
	"net/http"
	"strings"
	"sync"
)

// MemoryTransport is an in-process http.RoundTripper: responses are produced
// by registered routes without touching the network. It is the memory
// transport adapter used to exercise caching behavior under concurrency.
type MemoryTransport struct {
	mu sync.Mutex

	routes map[string]func(*http.Request) *http.Response

	requests     []*http.Request
	bodiesOpened int
	bodiesClosed int
}

// NewMemoryTransport constructs an empty MemoryTransport.
func NewMemoryTransport() *MemoryTransport {
	return &MemoryTransport{routes: make(map[string]func(*http.Request) *http.Response)}
}

// Handle registers a response factory for a URL.
func (m *MemoryTransport) Handle(url string, factory func(*http.Request) *http.Response) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.routes[url] = factory
}

// HandleResponse registers a fixed response for a URL. The response body is
// consumed once; routes hit repeatedly should use Handle with a factory that
// returns a fresh response per request.
func (m *MemoryTransport) HandleResponse(url string, resp *http.Response) {
	m.Handle(url, func(*http.Request) *http.Response { return resp })
}

// RoundTrip implements http.RoundTripper.
func (m *MemoryTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	m.mu.Lock()
	m.requests = append(m.requests, req)
	factory := m.routes[req.URL.String()]
	m.mu.Unlock()

	if factory == nil {
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Status:     http.StatusText(http.StatusNotFound),
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("")),
		}, nil
	}

	resp := factory(req)
	if resp.Header == nil {
		resp.Header = make(http.Header)
	}
	resp.Body = m.decorate(resp.Body)
	return resp, nil
}

func (m *MemoryTransport) decorate(body io.ReadCloser) io.ReadCloser {
	if body == nil {
		body = io.NopCloser(strings.NewReader(""))
	}
	if tracked, ok := body.(*trackingBody); ok {
		tracked.owner = m
		m.countOpen()
		return tracked
	}
	m.countOpen()
	return &trackingBody{ReadCloser: body, owner: m}
}

func (m *MemoryTransport) countOpen() {
	m.mu.Lock()
	m.bodiesOpened++
	m.mu.Unlock()
}

// Requests returns a snapshot of every request observed so far.
func (m *MemoryTransport) Requests() []*http.Request {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]*http.Request(nil), m.requests...)
}

// BodiesOpened reports how many response bodies have been handed out.
func (m *MemoryTransport) BodiesOpened() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.bodiesOpened
}

// BodiesClosed reports how many handed-out bodies have been closed.
func (m *MemoryTransport) BodiesClosed() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.bodiesClosed
}

// NewTrackingBody wraps body so its Close is accounted by the MemoryTransport
// that returns it. Factories use it when they need a custom failing or
// blocking stream.
func (m *MemoryTransport) NewTrackingBody(body io.ReadCloser) *trackingBody {
	return &trackingBody{ReadCloser: body, owner: m}
}

// trackingBody counts closes against the owning MemoryTransport.
type trackingBody struct {
	io.ReadCloser
	owner     *MemoryTransport
	closeOnce sync.Once
}

func (b *trackingBody) Close() error {
	err := b.ReadCloser.Close()
	b.closeOnce.Do(func() {
		b.owner.mu.Lock()
		b.owner.bodiesClosed++
		b.owner.mu.Unlock()
	})
	return err
}

// blockingReadCloser blocks Read until release is closed, then delegates.
// Tests use it to hold a Store call mid-body and prove atomic visibility.
type blockingReadCloser struct {
	reader    io.Reader
	release   <-chan struct{}
	closed    chan struct{}
	closeOnce sync.Once
}

func newBlockingReadCloser(content string, release <-chan struct{}) *blockingReadCloser {
	return &blockingReadCloser{
		reader:  strings.NewReader(content),
		release: release,
		closed:  make(chan struct{}),
	}
}

func (b *blockingReadCloser) Read(p []byte) (int, error) {
	<-b.release
	return b.reader.Read(p)
}

func (b *blockingReadCloser) Close() error {
	b.closeOnce.Do(func() { close(b.closed) })
	return nil
}

// Closed is signaled once the stream is closed.
func (b *blockingReadCloser) Closed() <-chan struct{} { return b.closed }
