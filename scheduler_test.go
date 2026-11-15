package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

type testFetcher struct {
	mu       sync.Mutex
	bodies   map[string][]byte
	failures map[string]int
	calls    map[string]int
	errs     map[string]error
}

func newTestFetcher() *testFetcher {
	return &testFetcher{
		bodies:   make(map[string][]byte),
		failures: make(map[string]int),
		calls:    make(map[string]int),
		errs:     make(map[string]error),
	}
}

func (f *testFetcher) set(url string, body []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bodies[url] = append([]byte(nil), body...)
}

func (f *testFetcher) fail(url string, times int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.failures[url] = times
}

func (f *testFetcher) setError(url string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errs[url] = err
}

func (f *testFetcher) callCount(url string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[url]
}

func (f *testFetcher) Fetch(ctx context.Context, url string) ([]byte, error) {
	if err := contextErr(ctx); err != nil {
		return nil, err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls[url]++
	if f.failures[url] > 0 {
		f.failures[url]--
		return nil, errors.New("temporary failure")
	}
	if err := f.errs[url]; err != nil {
		return nil, err
	}
	body, ok := f.bodies[url]
	if !ok {
		return nil, fmt.Errorf("unexpected fetch %s", url)
	}
	return append([]byte(nil), body...), nil
}

type recordingPublisher struct {
	mu       sync.Mutex
	pages    []Page
	failNext int
	calls    int
}

func (p *recordingPublisher) Publish(ctx context.Context, page Page) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.calls++
	if p.failNext > 0 {
		p.failNext--
		return errors.New("publish failed")
	}
	p.pages = append(p.pages, page)
	return nil
}

func (p *recordingPublisher) snapshot() []Page {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Page(nil), p.pages...)
}

func indexDoc(refs ...string) string {
	out := `<sitemapindex>`
	for _, ref := range refs {
		out += `<sitemap><loc>` + ref + `</loc></sitemap>`
	}
	return out + `</sitemapindex>`
}

func urlSetDoc(entries ...string) string {
	out := `<urlset>`
	for _, entry := range entries {
		out += `<url><loc>` + entry + `</loc></url>`
	}
	return out + `</urlset>`
}

func TestExpandIndexGzipCycleAndHostNormalization(t *testing.T) {
	fetcher := newTestFetcher()
	root := "https://example.com/sitemap.xml"
	child := "https://example.com/child.xml.gz"
	leaf := "https://example.com/leaf.xml"
	leaf2 := "https://example.com/leaf2.xml"

	fetcher.set(root, []byte(indexDoc(
		"https://EXAMPLE.com:443/child.xml.gz",
		"/leaf2.xml",
	)))
	fetcher.set(child, gzipString(t, indexDoc(
		root,
		leaf,
	)))
	fetcher.set(leaf, []byte(`<urlset>
  <url><loc>HTTP://Example.COM:80/a/../b?x=1#frag</loc></url>
  <url><loc>/page2</loc></url>
</urlset>`))
	fetcher.set(leaf2, []byte(urlSetDoc(
		"https://example.com/b?x=1",
		"https://other.example/x",
	)))

	scheduler := NewScheduler(fetcher,
		WithMaxAttempts(1),
		WithRetryBackoff(0),
	)
	graph, err := scheduler.Expand(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if !graph.Complete {
		t.Fatalf("graph incomplete: %#v", graph.Watermark)
	}
	if graph.Watermark.SitemapsTotal != 4 || graph.Watermark.SitemapsComplete != 4 {
		t.Fatalf("watermark = %#v", graph.Watermark)
	}
	if graph.Watermark.RootsComplete != 1 || graph.Watermark.RootsTotal != 1 {
		t.Fatalf("root watermark = %#v", graph.Watermark)
	}
	childNode := graph.Node(child)
	if childNode == nil || len(childNode.Cycles) != 1 || childNode.Cycles[0] != root {
		t.Fatalf("cycle not recorded: %#v", childNode)
	}
	if len(graph.Pages) != 4 {
		t.Fatalf("pages = %#v", graph.Pages)
	}
	got := map[string]Page{}
	for _, page := range graph.Pages {
		got[page.URL] = page
	}
	if _, ok := got["http://example.com/b?x=1"]; !ok {
		t.Fatalf("missing normalized page: %#v", graph.Pages)
	}
	if _, ok := got["https://example.com/page2"]; !ok {
		t.Fatalf("missing relative page: %#v", graph.Pages)
	}
	if _, ok := got["https://example.com/b?x=1"]; !ok {
		t.Fatalf("missing https variant: %#v", graph.Pages)
	}
	if _, ok := got["https://other.example/x"]; !ok {
		t.Fatalf("missing cross-host page: %#v", graph.Pages)
	}
	byHost := graph.PagesByHost()
	if len(byHost["example.com"]) != 3 || len(byHost["other.example"]) != 1 {
		t.Fatalf("hosts = %#v", byHost)
	}
}

func TestChildFailureDoesNotAdvanceParentAndRetryIsIdempotent(t *testing.T) {
	fetcher := newTestFetcher()
	publisher := &recordingPublisher{}
	store := NewMemoryStore()
	root := "https://example.com/root.xml"
	bad := "https://example.com/bad.xml"
	good := "https://example.com/good.xml"

	fetcher.set(root, []byte(indexDoc(bad, good)))
	fetcher.set(bad, []byte(urlSetDoc("https://example.com/bad-page")))
	fetcher.set(good, []byte(urlSetDoc("https://example.com/good-page")))
	fetcher.set("https://example.com/bad-page", []byte("bad content"))
	fetcher.set("https://example.com/good-page", []byte("good content"))
	fetcher.fail(bad, 1)

	scheduler := NewScheduler(fetcher,
		WithPublisher(publisher),
		WithStateStore(store),
		WithMaxAttempts(1),
		WithRetryBackoff(0),
	)
	report, err := scheduler.Run(context.Background(), []string{root})
	if err == nil {
		t.Fatal("expected first run error")
	}
	if report.Complete || report.Watermark.RootsComplete != 0 || report.Watermark.SitemapsFailed != 1 {
		t.Fatalf("watermark advanced incorrectly: %#v", report.Watermark)
	}
	if report.Sitemaps[root].Complete {
		t.Fatal("parent must be incomplete when a child fails")
	}
	if len(publisher.snapshot()) != 1 {
		t.Fatalf("published = %#v", publisher.snapshot())
	}

	report, err = scheduler.Run(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if !report.Complete || report.Watermark.RootsComplete != 1 || report.Watermark.SitemapsFailed != 0 {
		t.Fatalf("watermark did not advance: %#v", report.Watermark)
	}
	if len(publisher.snapshot()) != 2 {
		t.Fatalf("published after retry = %#v", publisher.snapshot())
	}
	if len(report.Published) != 1 {
		t.Fatalf("only the failed branch should publish on retry: %#v", report.Published)
	}

	_, err = scheduler.Run(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if len(publisher.snapshot()) != 2 {
		t.Fatalf("confirmed pages republished: %#v", publisher.snapshot())
	}
	// Content is deliberately fetched again: lastmod may not be trusted to
	// decide that a page is unchanged.
	if fetcher.callCount("https://example.com/good-page") < 2 {
		t.Fatalf("expected a fresh fingerprint check on retry")
	}
}

func TestLastModIsWeakHintAndFingerprintDrivesRevision(t *testing.T) {
	fetcher := newTestFetcher()
	publisher := &recordingPublisher{}
	store := NewMemoryStore()
	root := "https://example.com/sitemap.xml"
	pageURL := "https://example.com/page"

	fetcher.set(pageURL, []byte("first body"))
	doc := func(lastMod string) []byte {
		return []byte(`<urlset><url><loc>` + pageURL + `</loc><lastmod>` + lastMod + `</lastmod></url></urlset>`)
	}
	fetcher.set(root, doc("2024-01-01"))

	scheduler := NewScheduler(fetcher,
		WithPublisher(publisher),
		WithStateStore(store),
		WithFetchPageContent(true),
		WithMaxAttempts(1),
		WithRetryBackoff(0),
	)
	report, err := scheduler.Run(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Published) != 1 || report.Published[0].Revision != 1 {
		t.Fatalf("first publish = %#v", report.Published)
	}

	fetcher.set(root, doc("2025-12-31"))
	report, err = scheduler.Run(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Published) != 0 || len(report.Skipped) != 1 {
		t.Fatalf("lastmod-only change must not publish: %#v", report.Results)
	}
	if !report.Skipped[0].LastModHintOnly {
		t.Fatalf("expected lastmod-only hint: %#v", report.Skipped[0])
	}

	fetcher.set(pageURL, []byte("second body"))
	report, err = scheduler.Run(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Published) != 1 || report.Published[0].Revision != 2 || !report.Published[0].Changed {
		t.Fatalf("content change should publish revision 2: %#v", report.Results)
	}
	if len(publisher.snapshot()) != 2 {
		t.Fatalf("publisher pages = %#v", publisher.snapshot())
	}
}

func TestPublishFailureRetriesWithoutAdvancingState(t *testing.T) {
	fetcher := newTestFetcher()
	publisher := &recordingPublisher{failNext: 1}
	store := NewMemoryStore()
	root := "https://example.com/sitemap.xml"
	pageURL := "https://example.com/page"

	fetcher.set(root, []byte(urlSetDoc(pageURL)))
	fetcher.set(pageURL, []byte("body"))
	scheduler := NewScheduler(fetcher,
		WithPublisher(publisher),
		WithStateStore(store),
		WithFetchPageContent(true),
		WithMaxAttempts(1),
		WithRetryBackoff(0),
	)

	report, err := scheduler.Run(context.Background(), []string{root})
	if err == nil || len(report.Published) != 0 {
		t.Fatalf("first run should fail publish: err=%v report=%#v", err, report)
	}
	if _, ok, _ := store.Get(context.Background(), pageURL); ok {
		t.Fatal("failed publication must not be confirmed")
	}
	report, err = scheduler.Run(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Published) != 1 || report.Published[0].Revision != 1 {
		t.Fatalf("retry publish = %#v", report.Results)
	}
	_, err = scheduler.Run(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if publisher.calls != 2 {
		t.Fatalf("publish calls = %d, want 2", publisher.calls)
	}
}

func TestSelfCycleCompletes(t *testing.T) {
	fetcher := newTestFetcher()
	root := "https://example.com/sitemap.xml"
	fetcher.set(root, []byte(indexDoc(root)))
	scheduler := NewScheduler(fetcher, WithMaxAttempts(1), WithRetryBackoff(0))
	graph, err := scheduler.Expand(context.Background(), []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if !graph.Complete {
		t.Fatalf("self cycle should complete: %#v", graph.Watermark)
	}
	if len(graph.Nodes[root].Cycles) != 1 {
		t.Fatalf("cycles = %#v", graph.Nodes[root].Cycles)
	}
}

func TestMaxDepthMarksAncestorsIncomplete(t *testing.T) {
	fetcher := newTestFetcher()
	root := "https://example.com/0.xml"
	one := "https://example.com/1.xml"
	two := "https://example.com/2.xml"
	fetcher.set(root, []byte(indexDoc(one)))
	fetcher.set(one, []byte(indexDoc(two)))
	fetcher.set(two, []byte(urlSetDoc("https://example.com/page")))

	scheduler := NewScheduler(fetcher,
		WithMaxAttempts(1),
		WithRetryBackoff(0),
		WithMaxDepth(1),
	)
	graph, err := scheduler.Expand(context.Background(), []string{root})
	if !errors.Is(err, ErrMaxDepth) {
		t.Fatalf("err = %v", err)
	}
	if graph.Complete || graph.Nodes[root].Complete || graph.Nodes[one].Complete {
		t.Fatalf("ancestors should be incomplete: root=%#v one=%#v", graph.Nodes[root], graph.Nodes[one])
	}
}

func TestDecideRevision(t *testing.T) {
	lastMod := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	record := PageRecord{
		URL:         "https://example.com/a",
		Fingerprint: "aaa",
		Revision:    2,
		LastMod:     lastMod,
		Confirmed:   true,
	}
	decision := DecideRevision(record, true, "aaa", lastMod.Add(24*time.Hour))
	if decision.Publish || decision.Changed || !decision.LastModHintOnly {
		t.Fatalf("lastmod must not cause a revision: %#v", decision)
	}
	decision = DecideRevision(record, true, "bbb", lastMod)
	if !decision.Publish || !decision.Changed || decision.Revision != 3 {
		t.Fatalf("content change decision = %#v", decision)
	}
	record.Confirmed = false
	decision = DecideRevision(record, true, "aaa", lastMod)
	if !decision.Publish || decision.Changed || decision.Revision != 2 || decision.Reason != ReasonRetryPublish {
		t.Fatalf("retry decision = %#v", decision)
	}
	decision = DecideRevision(PageRecord{URL: "https://example.com/new"}, false, "ccc", lastMod)
	if !decision.Publish || !decision.FirstSeen || decision.Revision != 1 {
		t.Fatalf("new decision = %#v", decision)
	}
}
