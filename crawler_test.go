package dataeng

import (
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

const (
	testHost  = "crawl.example"
	otherHost = "other.example.org"
	testBase  = "http://" + testHost
)

type mockResponse struct {
	status      int
	contentType string
	body        string
	redirect    string
}

// mockTransport is an in-process replacement for a local HTTP service: no
// sockets are used, yet requests, redirects and hosts are fully exercised.
// It also records every request in order, including redirect follows.
type mockTransport struct {
	routes map[string]mockResponse
	paths  []string
	hosts  map[string]int
}

func newMockTransport() *mockTransport {
	routes := map[string]mockResponse{
		testHost + "/": {
			status:      http.StatusOK,
			contentType: "text/html; charset=utf-8",
			body: `<!DOCTYPE html>
<html><head><title>Home</title></head>
<body>
  <a href="/a">A</a>
  <a href="sub/b">B relative</a>
  <a href="/a#section">A again with fragment</a>
  <a href="mailto:user@example.com">Mail</a>
  <a href="https://other.example.org/c">Cross origin</a>
  <a href="::not-a-url">Malformed</a>
</body></html>`,
		},
		testHost + "/a":     {status: http.StatusOK, contentType: "text/html", body: `<a href='/'>Home</a><a href="/loop">Loop</a>`},
		testHost + "/sub/b": {status: http.StatusOK, contentType: "text/html", body: `<A HREF="/a">uppercase A</A>`},

		// Redirect loop: /loop -> /loop2 -> /loop.
		testHost + "/loop":  {status: http.StatusFound, redirect: "/loop2"},
		testHost + "/loop2": {status: http.StatusFound, redirect: "/loop"},

		// Cross-origin redirect target; the disallowed host must never be hit.
		testHost + "/escape": {status: http.StatusFound, redirect: "https://" + otherHost + "/leak"},
		otherHost + "/leak":  {status: http.StatusOK, contentType: "text/html", body: "leaked"},
		otherHost + "/c":     {status: http.StatusOK, contentType: "text/html", body: "cross"},

		// Successful chain with a relative redirect and a fragment.
		testHost + "/start": {status: http.StatusTemporaryRedirect, redirect: "mid"},
		testHost + "/mid":   {status: http.StatusSeeOther, redirect: "/dest#frag"},
		testHost + "/dest":  {status: http.StatusOK, contentType: "text/html", body: `<a href="/">Home</a>`},

		// Plain text must not be parsed for links.
		testHost + "/plain": {status: http.StatusOK, contentType: "text/plain", body: `<a href="/should-not-appear">x</a>`},

		// Chain used for request-limit tests.
		testHost + "/chain":  {status: http.StatusFound, redirect: "/chain1"},
		testHost + "/chain1": {status: http.StatusFound, redirect: "/chain2"},
		testHost + "/chain2": {status: http.StatusOK, contentType: "text/html", body: `<a href="/a">A</a>`},
	}
	return &mockTransport{routes: routes, hosts: map[string]int{}}
}

func (m *mockTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	m.paths = append(m.paths, request.URL.Path)
	m.hosts[request.URL.Hostname()]++

	route, ok := m.routes[request.URL.Host+request.URL.Path]
	if !ok {
		return &http.Response{
			StatusCode: http.StatusNotFound,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader("not found")),
			Request:    request,
		}, nil
	}

	header := make(http.Header)
	if route.contentType != "" {
		header.Set("Content-Type", route.contentType)
	}
	if route.redirect != "" {
		header.Set("Location", route.redirect)
	}
	return &http.Response{
		StatusCode: route.status,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(route.body)),
		Request:    request,
	}, nil
}

func (m *mockTransport) addRoute(host, path string, route mockResponse) {
	m.routes[host+path] = route
}

func rejectMap(rejects []Reject) map[string]string {
	out := map[string]string{}
	for _, reject := range rejects {
		out[reject.URL] = reject.Reason
	}
	return out
}

func containsEdge(edges []Edge, want Edge) bool {
	for _, edge := range edges {
		if edge == want {
			return true
		}
	}
	return false
}

func allowedTestHosts() map[string]bool {
	return map[string]bool{testHost: true}
}

func TestCrawlBFSRelativeLinksDedupAndRejects(t *testing.T) {
	transport := newMockTransport()
	result := NewCrawler(transport).Crawl(testBase+"/", allowedTestHosts(), 100)

	// BFS order: home, then /a and /sub/b in document order. /a appears twice
	// in the home markup (fragment and duplicate) but is only requested once.
	wantPrefix := []string{"/", "/a", "/sub/b"}
	if len(transport.paths) < len(wantPrefix) {
		t.Fatalf("requests = %v, want prefix %v", transport.paths, wantPrefix)
	}
	for i, want := range wantPrefix {
		if transport.paths[i] != want {
			t.Fatalf("request order = %v, want prefix %v", transport.paths, wantPrefix)
		}
	}

	counts := map[string]int{}
	for _, path := range transport.paths {
		counts[path]++
	}
	if counts["/a"] != 1 {
		t.Fatalf("/a requested %d times, want 1; requests=%v", counts["/a"], transport.paths)
	}

	home := testBase + "/"
	if !containsEdge(result.Edges, Edge{From: home, To: testBase + "/a"}) ||
		!containsEdge(result.Edges, Edge{From: home, To: testBase + "/sub/b"}) {
		t.Fatalf("missing expected edges in %+v", result.Edges)
	}

	rejects := rejectMap(result.Rejects)
	if rejects["mailto:user@example.com"] != ReasonUnsupportedScheme {
		t.Fatalf("mailto reject = %q, rejects=%v", rejects["mailto:user@example.com"], rejects)
	}
	if rejects["https://"+otherHost+"/c"] != ReasonHostNotAllowed {
		t.Fatalf("cross-origin link reject missing: %v", rejects)
	}
	if rejects["::not-a-url"] != ReasonMalformedURL {
		t.Fatalf("malformed link reject missing: %v", rejects)
	}
	if len(result.Pending) != 0 {
		t.Fatalf("pending = %v, want empty", result.Pending)
	}

	// Final URL resolution uses the final response URL; visit order matches BFS.
	if len(result.Visits) == 0 || result.Visits[0].RequestURL != home {
		t.Fatalf("visits = %+v", result.Visits)
	}
}

func TestCrossOriginRedirectIsNeverRequested(t *testing.T) {
	transport := newMockTransport()
	result := NewCrawler(transport).Crawl(testBase+"/escape", allowedTestHosts(), 10)

	if transport.hosts[otherHost] != 0 {
		t.Fatalf("disallowed host was contacted: %v", transport.hosts)
	}
	rejects := rejectMap(result.Rejects)
	if rejects["https://"+otherHost+"/leak"] != ReasonHostNotAllowed {
		t.Fatalf("redirect target reject missing: %v", rejects)
	}
	if len(result.Visits) != 1 || result.Visits[0].FinalURL != testBase+"/escape" {
		t.Fatalf("visit = %+v, want chain stopped at /escape", result.Visits)
	}
	if !reflect.DeepEqual(transport.paths, []string{"/escape"}) {
		t.Fatalf("requests = %v, want only /escape", transport.paths)
	}
}

func TestRedirectLoopStopsAndIsRejected(t *testing.T) {
	transport := newMockTransport()
	result := NewCrawler(transport).Crawl(testBase+"/loop", allowedTestHosts(), 100)

	// /loop and /loop2 are requested; the third target, /loop, is already
	// requested so no third HTTP request is issued and the chain stops.
	if !reflect.DeepEqual(transport.paths, []string{"/loop", "/loop2"}) {
		t.Fatalf("requests = %v, want two requests then loop stop", transport.paths)
	}
	rejects := rejectMap(result.Rejects)
	if rejects[testBase+"/loop"] != ReasonRedirectAlreadyRequested {
		t.Fatalf("loop rejection missing: %v", rejects)
	}
	// /loop2's response was the last one received on the stopped chain.
	if len(result.Visits) != 1 || result.Visits[0].StatusCode != http.StatusFound {
		t.Fatalf("visit = %+v", result.Visits)
	}
}

func TestRedirectChainResolvesRelativeAndStripsFragment(t *testing.T) {
	transport := newMockTransport()
	result := NewCrawler(transport).Crawl(testBase+"/start", allowedTestHosts(), 100)

	wantPrefix := []string{"/start", "/mid", "/dest"}
	if len(transport.paths) < len(wantPrefix) {
		t.Fatalf("requests = %v, want prefix %v", transport.paths, wantPrefix)
	}
	if !reflect.DeepEqual(transport.paths[:3], wantPrefix) {
		t.Fatalf("requests = %v, want prefix %v", transport.paths, wantPrefix)
	}
	if result.Visits[0].RequestURL != testBase+"/start" {
		t.Fatalf("first visit = %+v", result.Visits[0])
	}
	visit := result.Visits[0]
	if visit.FinalURL != testBase+"/dest" {
		t.Fatalf("final URL = %q, want fragment-stripped /dest", visit.FinalURL)
	}
	if visit.StatusCode != http.StatusOK || !reflect.DeepEqual(visit.Links, []string{"/"}) {
		t.Fatalf("final visit = %+v", visit)
	}
	for _, pending := range result.Pending {
		if pending == testBase+"/dest" {
			t.Fatalf("followed redirect target left in pending queue: %v", result.Pending)
		}
	}
}

func TestRequestLimitStopsMidRedirectChain(t *testing.T) {
	transport := newMockTransport()
	result := NewCrawler(transport).Crawl(testBase+"/chain", allowedTestHosts(), 2)

	if !reflect.DeepEqual(transport.paths, []string{"/chain", "/chain1"}) {
		t.Fatalf("requests = %v, want exactly two", transport.paths)
	}
	if !reflect.DeepEqual(result.PendingRedirects, []string{testBase + "/chain2"}) {
		t.Fatalf("pending redirects = %v, want unrequested /chain2", result.PendingRedirects)
	}
	if len(result.Visits) != 1 {
		t.Fatalf("visits = %+v", result.Visits)
	}
}

func TestRequestLimitLeavesUnprocessedQueue(t *testing.T) {
	transport := newMockTransport()
	result := NewCrawler(transport).Crawl(testBase+"/", allowedTestHosts(), 1)

	if !reflect.DeepEqual(transport.paths, []string{"/"}) {
		t.Fatalf("requests = %v", transport.paths)
	}
	wantPending := []string{testBase + "/a", testBase + "/sub/b"}
	if !reflect.DeepEqual(result.Pending, wantPending) {
		t.Fatalf("pending = %v, want %v", result.Pending, wantPending)
	}
}

func TestRedirectToAlreadyRequestedURLStopsChain(t *testing.T) {
	transport := newMockTransport()
	transport.addRoute(testHost, "/b", mockResponse{status: http.StatusFound, redirect: "/a"})
	transport.addRoute(testHost, "/seed", mockResponse{
		status:      http.StatusOK,
		contentType: "text/html",
		body:        `<a href="/a">A</a><a href="/b">B</a>`,
	})

	result := NewCrawler(transport).Crawl(testBase+"/seed", allowedTestHosts(), 100)

	counts := map[string]int{}
	for _, path := range transport.paths {
		counts[path]++
	}
	// /seed, /a, then /b redirects into the already requested /a and stops;
	// later BFS pages may still be crawled, but /a must never repeat.
	if counts["/seed"] != 1 || counts["/a"] != 1 || counts["/b"] != 1 {
		t.Fatalf("request counts = %v, paths = %v", counts, transport.paths)
	}
	rejects := rejectMap(result.Rejects)
	if rejects[testBase+"/a"] != ReasonRedirectAlreadyRequested {
		t.Fatalf("expected already-requested redirect rejection, got %v", rejects)
	}
	// Cross-origin links on seeded pages are rejected, not host failures.
	for _, reject := range result.Rejects {
		if reject.Reason == ReasonHostNotAllowed &&
			!strings.HasPrefix(reject.URL, "https://"+otherHost) {
			t.Fatalf("unexpected host rejection: %+v", reject)
		}
	}
}

func TestRedirectToOnlyEnqueuedURLIsFollowedAndThenSkipped(t *testing.T) {
	transport := newMockTransport()
	transport.addRoute(testHost, "/jump", mockResponse{status: http.StatusFound, redirect: "/a"})
	transport.addRoute(testHost, "/seed", mockResponse{
		status:      http.StatusOK,
		contentType: "text/html",
		// /jump enqueued first, /a second; /jump redirects into enqueued /a.
		body: `<a href="/jump">Jump</a><a href="/a">A</a>`,
	})
	transport.addRoute(testHost, "/a", mockResponse{
		status:      http.StatusOK,
		contentType: "text/html",
		body:        `ok`,
	})

	result := NewCrawler(transport).Crawl(testBase+"/seed", allowedTestHosts(), 100)

	// /seed, /jump (redirect), /a followed immediately: /a is requested once
	// even though it also sat in the BFS queue, where it is marked processed.
	if !reflect.DeepEqual(transport.paths, []string{"/seed", "/jump", "/a"}) {
		t.Fatalf("request order = %v", transport.paths)
	}
	if len(result.Pending) != 0 {
		t.Fatalf("pending = %v, want empty", result.Pending)
	}
	if len(result.Visits) != 2 {
		t.Fatalf("visits = %+v, want two chains", result.Visits)
	}
	jump := result.Visits[1]
	if jump.RequestURL != testBase+"/jump" || jump.FinalURL != testBase+"/a" {
		t.Fatalf("jump visit = %+v", jump)
	}
}

func TestOnlySuccessfulHTMLIsParsed(t *testing.T) {
	transport := newMockTransport()
	result := NewCrawler(transport).Crawl(testBase+"/plain", allowedTestHosts(), 10)

	if len(result.Visits) != 1 || len(result.Visits[0].Links) != 0 {
		t.Fatalf("visits = %+v, want no extracted links", result.Visits)
	}
	if len(result.Edges) != 0 {
		t.Fatalf("edges = %v, want none", result.Edges)
	}
}

func TestCanonicalizationRules(t *testing.T) {
	cases := []struct {
		input  string
		want   string
		reason string
	}{
		{"https://Example.COM/Path?q=1#frag", "https://example.com/Path?q=1", ""},
		{"http://example.com/a#x", "http://example.com/a", ""},
		{"ftp://example.com/a", "", ReasonUnsupportedScheme},
		{":bad:", "", ReasonMalformedURL},
		{"//example.com/a", "", ReasonUnsupportedScheme},
	}
	for _, tc := range cases {
		got, reason := canonicalize(tc.input)
		if got != tc.want || reason != tc.reason {
			t.Fatalf("canonicalize(%q) = (%q, %q), want (%q, %q)",
				tc.input, got, reason, tc.want, tc.reason)
		}
	}
}

func TestHostnameCaseInsensitiveAndPortAgnostic(t *testing.T) {
	transport := newMockTransport()
	allowed := map[string]bool{strings.ToUpper(testHost): true}
	result := NewCrawler(transport).Crawl(testBase+"/", allowed, 100)

	if len(result.Visits) == 0 {
		t.Fatalf("expected visits with case-insensitive allowed host, got %+v", result)
	}
	for _, reject := range result.Rejects {
		if reject.Reason == ReasonHostNotAllowed &&
			!strings.HasPrefix(reject.URL, "https://"+otherHost) {
			t.Fatalf("unexpected host rejection: %+v", reject)
		}
	}

	// Allowed set entries may carry a port; the bare hostname must still match.
	transport2 := newMockTransport()
	withPort := map[string]bool{testHost + ":8080": true}
	result2 := NewCrawler(transport2).Crawl(testBase+"/", withPort, 100)
	if len(result2.Visits) == 0 {
		t.Fatalf("expected visits with port-bearing allowed host, got %+v", result2)
	}
}

func TestInvalidStartURLIsRejectedWithoutRequests(t *testing.T) {
	transport := newMockTransport()
	result := NewCrawler(transport).Crawl("::not-a-url", map[string]bool{testHost: true}, 10)

	if len(transport.paths) != 0 {
		t.Fatalf("requests = %v, want none", transport.paths)
	}
	if len(result.Visits) != 0 || len(result.Rejects) != 1 {
		t.Fatalf("result = %+v, want one rejection and no visits", result)
	}
	if result.Rejects[0].Reason != ReasonMalformedURL {
		t.Fatalf("reject = %+v", result.Rejects[0])
	}
}

func TestNonPositiveLimitMakesNoRequests(t *testing.T) {
	transport := newMockTransport()
	result := NewCrawler(transport).Crawl(testBase+"/", allowedTestHosts(), 0)
	if len(transport.paths) != 0 || len(result.Visits) != 0 {
		t.Fatalf("result = %+v, requests = %v", result, transport.paths)
	}
}

func TestTransportErrorIsRecordedInVisit(t *testing.T) {
	transport := &errorTransport{}
	result := NewCrawler(transport).Crawl(testBase+"/", allowedTestHosts(), 5)

	if len(result.Visits) != 1 || result.Visits[0].Error == nil {
		t.Fatalf("visits = %+v, want transport error recorded", result.Visits)
	}
}

type errorTransport struct{}

func (errorTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, io.EOF
}

func TestNilTransportDefaultsToDefaultTransport(t *testing.T) {
	crawler := NewCrawler(nil)
	if crawler.transport != http.DefaultTransport {
		t.Fatalf("transport = %v, want http.DefaultTransport", crawler.transport)
	}
}

func TestUnsupportedSchemeRedirectIsRejected(t *testing.T) {
	transport := newMockTransport()
	transport.addRoute(testHost, "/ftp", mockResponse{
		status:   http.StatusMovedPermanently,
		redirect: "ftp://crawl.example/file",
	})
	result := NewCrawler(transport).Crawl(testBase+"/ftp", allowedTestHosts(), 10)

	if !reflect.DeepEqual(transport.paths, []string{"/ftp"}) {
		t.Fatalf("requests = %v, want no follow", transport.paths)
	}
	rejects := rejectMap(result.Rejects)
	if rejects["ftp://crawl.example/file"] != ReasonUnsupportedScheme {
		t.Fatalf("rejects = %v", rejects)
	}
}

func TestNonRedirectStatusIsNotFollowed(t *testing.T) {
	transport := newMockTransport()
	transport.addRoute(testHost, "/weird", mockResponse{
		status:      http.StatusTeapot,
		contentType: "text/html",
		body:        `<a href="/a">A</a>`,
	})
	result := NewCrawler(transport).Crawl(testBase+"/weird", allowedTestHosts(), 10)

	// 4xx is not a success: links must not be extracted.
	if len(result.Visits) != 1 || result.Visits[0].StatusCode != http.StatusTeapot {
		t.Fatalf("visits = %+v", result.Visits)
	}
	if len(result.Visits[0].Links) != 0 || len(result.Edges) != 0 {
		t.Fatalf("links=%v edges=%v, want no extraction on non-2xx", result.Visits[0].Links, result.Edges)
	}
}

func TestUppercaseHostAndFragmentDeduplicate(t *testing.T) {
	transport := newMockTransport()
	transport.addRoute(testHost, "/dup", mockResponse{
		status:      http.StatusOK,
		contentType: "text/html",
		body:        `<a href="http://CRAWL.Example/a#one">1</a><a href="http://crawl.example/a#two">2</a>`,
	})
	result := NewCrawler(transport).Crawl(testBase+"/dup", allowedTestHosts(), 100)

	count := 0
	for _, path := range transport.paths {
		if path == "/a" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("/a requested %d times, paths = %v", count, transport.paths)
	}
	wantEdge := Edge{From: testBase + "/dup", To: testBase + "/a"}
	if result.Edges[0] != wantEdge || result.Edges[1] != wantEdge {
		t.Fatalf("first edges = %+v, want two duplicate canonical edges", result.Edges[:2])
	}
}

func TestRelativeLinksResolveAgainstFinalResponseURL(t *testing.T) {
	transport := newMockTransport()
	transport.addRoute(testHost, "/dir/start", mockResponse{
		status:   http.StatusFound,
		redirect: "final/",
	})
	transport.addRoute(testHost, "/dir/final/", mockResponse{
		status:      http.StatusOK,
		contentType: "text/html",
		body:        `<a href="child">child</a>`,
	})
	result := NewCrawler(transport).Crawl(testBase+"/dir/start", allowedTestHosts(), 100)

	want := Edge{From: testBase + "/dir/final/", To: testBase + "/dir/final/child"}
	if !containsEdge(result.Edges, want) {
		t.Fatalf("edges = %+v, want %+v", result.Edges, want)
	}
}
