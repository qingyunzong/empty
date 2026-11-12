package streamdl

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"sync"
)

// pipeServer is an in-process HTTP server backed by net.Pipe. It preserves
// real HTTP framing, status codes, headers, hijacking and context
// cancellation without binding any network socket (sandboxes often forbid
// listen(2)).
type pipeServer struct {
	URL    string
	client *http.Client

	listener *pipeListener
	serveWG  sync.WaitGroup
}

func newPipeServer(handler http.Handler) *pipeServer {
	ln := newPipeListener()
	srv := &http.Server{Handler: handler}
	ps := &pipeServer{
		URL:      "http://pipe.test",
		listener: ln,
		client: &http.Client{
			Transport: &pipeRoundTripper{listener: ln},
		},
	}
	ps.serveWG.Add(1)
	go func() {
		defer ps.serveWG.Done()
		_ = srv.Serve(ln)
	}()
	return ps
}

// pipeRequester adapts a pipeServer to the streamdl.Requester signature.
func pipeRequester(ps *pipeServer) Requester {
	return func(ctx context.Context, method string, headers http.Header) (*http.Response, error) {
		req, err := http.NewRequestWithContext(ctx, method, ps.URL, nil)
		if err != nil {
			return nil, err
		}
		for key, values := range headers {
			for _, value := range values {
				req.Header.Add(key, value)
			}
		}
		return ps.client.Do(req)
	}
}

func (p *pipeServer) Client() *http.Client { return p.client }

func (p *pipeServer) Close() {
	p.listener.closeAll()
	p.serveWG.Wait()
}

type pipeRoundTripper struct {
	listener *pipeListener
}

func (rt *pipeRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	client, server := bufferedPipe()
	rt.listener.serveConn(server)
	// Propagate request cancellation into the in-memory connection so a
	// blocked body Read returns when the context is canceled.
	stopCancel := make(chan struct{})
	go func() {
		select {
		case <-req.Context().Done():
			_ = client.Close()
		case <-stopCancel:
		}
	}()
	go func() {
		_ = req.Write(client)
	}()
	reader := bufio.NewReader(client)
	resp, err := http.ReadResponse(reader, req)
	if err != nil {
		close(stopCancel)
		_ = client.Close()
		return nil, err
	}
	resp.Request = req
	// Keep the connection alive behind the response body.
	resp.Body = &pipeBody{body: resp.Body, conn: client, stopCancel: stopCancel}
	return resp, nil
}

type pipeBody struct {
	body       io.ReadCloser
	conn       net.Conn
	stopCancel chan struct{}
	once       sync.Once
}

func (b *pipeBody) Read(p []byte) (int, error) {
	return b.body.Read(p)
}

func (b *pipeBody) Close() error {
	_ = b.body.Close()
	var err error
	b.once.Do(func() {
		close(b.stopCancel)
		err = b.conn.Close()
	})
	return err
}

type pipeListener struct {
	mu     sync.Mutex
	conns  chan net.Conn
	closed bool
	active []net.Conn
}

func newPipeListener() *pipeListener {
	return &pipeListener{conns: make(chan net.Conn, 16)}
}

func (l *pipeListener) Accept() (net.Conn, error) {
	conn, ok := <-l.conns
	if !ok {
		return nil, net.ErrClosed
	}
	return conn, nil
}

func (l *pipeListener) serveConn(conn net.Conn) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		_ = conn.Close()
		return
	}
	l.active = append(l.active, conn)
	l.conns <- conn
}

func (l *pipeListener) closeAll() {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.closed = true
	close(l.conns)
	conns := append([]net.Conn(nil), l.active...)
	l.active = nil
	l.mu.Unlock()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

func (l *pipeListener) Addr() net.Addr { return pipeAddr{} }
func (l *pipeListener) Close() error {
	l.closeAll()
	return nil
}

type pipeAddr struct{}

func (pipeAddr) Network() string { return "pipe" }
func (pipeAddr) String() string  { return "pipe" }
