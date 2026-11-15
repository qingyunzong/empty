package dataeng

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// Page is a canonical page location discovered through a sitemap.
type Page struct {
	URL         string
	Loc         string
	Host        string
	LastMod     time.Time
	LastModRaw  string
	ChangeFreq  string
	Priority    float64
	HasPriority bool
	Sitemap     string
	Sources     []string
	Content     []byte
	Fingerprint string
	Revision    int64
}

// Publisher receives pages whose content fingerprint differs from the last
// confirmed fingerprint. Returning an error leaves the page unconfirmed, so a
// later retry will publish it again.
type Publisher interface {
	Publish(ctx context.Context, page Page) error
}

// PublisherFunc adapts a function to Publisher.
type PublisherFunc func(ctx context.Context, page Page) error

func (f PublisherFunc) Publish(ctx context.Context, page Page) error {
	return f(ctx, page)
}

// PageContentProvider supplies the bytes used to compute a page fingerprint.
// It is normally backed by the crawler's fetch/cache layer.
type PageContentProvider interface {
	PageContent(ctx context.Context, page Page) ([]byte, error)
}

// PageContentFunc adapts a function to PageContentProvider.
type PageContentFunc func(ctx context.Context, page Page) ([]byte, error)

func (f PageContentFunc) PageContent(ctx context.Context, page Page) ([]byte, error) {
	return f(ctx, page)
}

// Aliases for callers that model this as a page fetch/load step.
type (
	PageFetcher       = PageContentProvider
	PageLoader        = PageContentProvider
	PageContentLoader = PageContentProvider
	PageSource        = PageContentProvider
)

// NodeStatus is the state of one sitemap graph node.
type NodeStatus uint8

const (
	NodePending NodeStatus = iota
	NodeFetching
	NodeComplete
	NodeFailed
	NodeIncomplete
)

func (s NodeStatus) String() string {
	switch s {
	case NodePending:
		return "pending"
	case NodeFetching:
		return "fetching"
	case NodeComplete:
		return "complete"
	case NodeFailed:
		return "failed"
	case NodeIncomplete:
		return "incomplete"
	default:
		return "unknown"
	}
}

// SitemapNode is one expanded sitemap. For an index, Complete is true only
// when every non-cyclic child is complete.
type SitemapNode struct {
	URL              string
	Kind             Kind
	Depth            int
	Root             bool
	Status           NodeStatus
	Complete         bool
	Children         []string
	Cycles           []string
	Pages            []Page
	LastMod          time.Time
	Attempts         int
	ChildrenTotal    int
	ChildrenComplete int
	Err              error
}

// Watermark summarizes how far a sitemap graph has completed. Complete only
// advances when every root and every reachable non-cyclic child completed.
type Watermark struct {
	Complete           bool
	RootsTotal         int
	RootsComplete      int
	SitemapsTotal      int
	SitemapsComplete   int
	SitemapsFailed     int
	SitemapsIncomplete int
	PagesTotal         int
}

// Advanced reports whether the graph watermark reached full completion.
func (w Watermark) Advanced() bool { return w.Complete }

// Progress is an alias for Watermark.
type Progress = Watermark

// Graph is the result of sitemap expansion. Pages contains globally
// de-duplicated canonical locations in deterministic discovery order.
type Graph struct {
	Roots     []string
	Order     []string
	Nodes     map[string]*SitemapNode
	Pages     []Page
	Errors    []error
	Warnings  []error
	Complete  bool
	Watermark Watermark
}

// Node looks up a node by canonical URL, normalizing the argument when needed.
func (g *Graph) Node(rawURL string) *SitemapNode {
	if g == nil {
		return nil
	}
	if node, ok := g.Nodes[rawURL]; ok {
		return node
	}
	if normalized, err := NormalizeURL(rawURL); err == nil {
		return g.Nodes[normalized]
	}
	return nil
}

// PagesByHost groups canonical pages by normalized host.
func (g *Graph) PagesByHost() map[string][]Page {
	out := make(map[string][]Page)
	if g == nil {
		return out
	}
	for _, page := range g.Pages {
		out[page.Host] = append(out[page.Host], page)
	}
	return out
}

// Err aggregates expansion errors.
func (g *Graph) Err() error {
	if g == nil {
		return nil
	}
	return NewMultiError(g.Errors...)
}

// PageResult records the revision decision and publication outcome for one
// page.
type PageResult struct {
	Page                Page
	Fingerprint         string
	PreviousFingerprint string
	Revision            int64
	Changed             bool
	Published           bool
	Skipped             bool
	LastModHintOnly     bool
	Reason              string
	Err                 error
}

// Report is the result of Scheduler.Run.
type Report struct {
	Roots     []string
	Sitemaps  map[string]*SitemapNode
	Pages     []Page
	Results   []PageResult
	Published []PageResult
	Skipped   []PageResult
	Errors    []error
	Warnings  []error
	Complete  bool
	Success   bool
	Watermark Watermark
}

// PublishedPages returns the pages emitted during the run.
func (r *Report) PublishedPages() []Page {
	if r == nil {
		return nil
	}
	out := make([]Page, 0, len(r.Published))
	for _, result := range r.Published {
		out = append(out, result.Page)
	}
	return out
}

// Err aggregates run errors.
func (r *Report) Err() error {
	if r == nil {
		return nil
	}
	return NewMultiError(r.Errors...)
}

// Option configures a Scheduler.
type Option func(*Scheduler)

// Scheduler expands sitemaps, decides revisions and publishes pages.
//
// A Scheduler is safe for one concurrent Run/Expand at a time; calls are
// serialized. Do not copy a Scheduler after first use.
type Scheduler struct {
	Fetcher          Fetcher
	Publisher        Publisher
	State            StateStore
	PageContent      PageContentProvider
	Fingerprinter    func([]byte) string
	MaxDepth         int
	MaxAttempts      int
	MaxRetries       int
	RetryBackoff     time.Duration
	MaxSitemapBytes  int64
	MaxPageBytes     int64
	FetchPageContent bool
	DisablePageFetch bool
	Clock            func() time.Time

	runMu sync.Mutex
}

// NewScheduler constructs a scheduler around fetcher.
func NewScheduler(fetcher Fetcher, opts ...Option) *Scheduler {
	s := &Scheduler{
		Fetcher:         fetcher,
		State:           NewMemoryStore(),
		Fingerprinter:   ContentFingerprint,
		MaxDepth:        32,
		MaxAttempts:     3,
		MaxRetries:      2,
		RetryBackoff:    25 * time.Millisecond,
		MaxSitemapBytes: DefaultMaxBodyBytes,
		MaxPageBytes:    DefaultMaxBodyBytes,
		Clock:           time.Now,
	}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	return s
}

// New constructs a scheduler without a fetcher. Use WithFetcher when fetching
// is required.
func New(opts ...Option) *Scheduler {
	return NewScheduler(nil, opts...)
}

// NewWithOptions is an alias for New.
func NewWithOptions(opts ...Option) *Scheduler { return New(opts...) }

// WithFetcher sets the sitemap/page fetcher.
func WithFetcher(fetcher Fetcher) Option {
	return func(s *Scheduler) { s.Fetcher = fetcher }
}

// WithLoader is an alias for WithFetcher.
func WithLoader(fetcher Fetcher) Option { return WithFetcher(fetcher) }

// WithPublisher sets the publication sink.
func WithPublisher(publisher Publisher) Option {
	return func(s *Scheduler) { s.Publisher = publisher }
}

// WithStateStore sets the persistent revision store.
func WithStateStore(store StateStore) Option {
	return func(s *Scheduler) { s.State = store }
}

// WithStore is an alias for WithStateStore.
func WithStore(store StateStore) Option { return WithStateStore(store) }

// WithRevisionStore is an alias for WithStateStore.
func WithRevisionStore(store StateStore) Option { return WithStateStore(store) }

// WithPageContentProvider sets the page body source used for fingerprinting.
func WithPageContentProvider(provider PageContentProvider) Option {
	return func(s *Scheduler) { s.PageContent = provider }
}

// WithPageFetcher is an alias for WithPageContentProvider.
func WithPageFetcher(provider PageContentProvider) Option {
	return WithPageContentProvider(provider)
}

// WithFingerprinter overrides the SHA-256 content fingerprint function.
func WithFingerprinter(fn func([]byte) string) Option {
	return func(s *Scheduler) { s.Fingerprinter = fn }
}

// WithMaxDepth limits sitemap index nesting. Cycles are broken independently
// of this limit.
func WithMaxDepth(depth int) Option {
	return func(s *Scheduler) { s.MaxDepth = depth }
}

// WithMaxAttempts sets total fetch attempts per sitemap/page.
func WithMaxAttempts(attempts int) Option {
	return func(s *Scheduler) {
		if attempts < 1 {
			attempts = 1
		}
		s.MaxAttempts = attempts
		s.MaxRetries = attempts - 1
	}
}

// WithMaxRetries sets retries after the initial attempt.
func WithMaxRetries(retries int) Option {
	return func(s *Scheduler) {
		if retries < 0 {
			retries = 0
		}
		s.MaxRetries = retries
		s.MaxAttempts = retries + 1
	}
}

// WithRetryBackoff sets the base exponential retry delay. Zero disables
// sleeping between attempts.
func WithRetryBackoff(delay time.Duration) Option {
	return func(s *Scheduler) { s.RetryBackoff = delay }
}

// WithMaxSitemapBytes sets the compressed/decompressed sitemap body limit.
func WithMaxSitemapBytes(limit int64) Option {
	return func(s *Scheduler) { s.MaxSitemapBytes = limit }
}

// WithMaxPageBytes sets the page body limit.
func WithMaxPageBytes(limit int64) Option {
	return func(s *Scheduler) { s.MaxPageBytes = limit }
}

// WithFetchPageContent controls whether a publisher run fetches page bodies via
// Fetcher when no PageContentProvider was supplied.
func WithFetchPageContent(enabled bool) Option {
	return func(s *Scheduler) {
		s.FetchPageContent = enabled
		s.DisablePageFetch = !enabled
	}
}

// WithClock overrides time.Now for tests and deterministic embedding.
func WithClock(now func() time.Time) Option {
	return func(s *Scheduler) { s.Clock = now }
}

// Expand expands roots into a sitemap graph and page list without publishing.
func (s *Scheduler) Expand(ctx context.Context, roots []string) (*Graph, error) {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	s.ensureDefaults()
	if ctx == nil {
		ctx = context.Background()
	}
	graph := s.expand(ctx, roots)
	return graph, graph.Err()
}

// ExpandURLs is the variadic form of Expand.
func (s *Scheduler) ExpandURLs(ctx context.Context, roots ...string) (*Graph, error) {
	return s.Expand(ctx, roots)
}

// Run expands roots, fingerprints pages and publishes content revisions.
//
// Publication is idempotent: a page whose fingerprint is unchanged and already
// confirmed is reported as skipped, even if its sitemap lastmod changed or a
// failed sibling is being retried.
func (s *Scheduler) Run(ctx context.Context, roots []string) (*Report, error) {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	s.ensureDefaults()
	if ctx == nil {
		ctx = context.Background()
	}

	graph := s.expand(ctx, roots)
	report := &Report{
		Roots:     append([]string(nil), graph.Roots...),
		Sitemaps:  graph.Nodes,
		Pages:     graph.Pages,
		Errors:    append([]error(nil), graph.Errors...),
		Warnings:  append([]error(nil), graph.Warnings...),
		Complete:  graph.Complete,
		Watermark: graph.Watermark,
	}
	if s.Publisher != nil {
		s.processPages(ctx, graph, report)
	}
	report.Success = report.Complete && len(report.Errors) == 0
	return report, report.Err()
}

// RunURLs is the variadic form of Run.
func (s *Scheduler) RunURLs(ctx context.Context, roots ...string) (*Report, error) {
	return s.Run(ctx, roots)
}

// Crawl is a convenience wrapper around Run.
func (s *Scheduler) Crawl(ctx context.Context, roots []string) (*Report, error) {
	return s.Run(ctx, roots)
}

func (s *Scheduler) ensureDefaults() {
	if s.MaxDepth <= 0 {
		s.MaxDepth = 32
	}
	if s.MaxAttempts <= 0 {
		if s.MaxRetries > 0 {
			s.MaxAttempts = s.MaxRetries + 1
		} else {
			s.MaxAttempts = 3
		}
	}
	if s.RetryBackoff < 0 {
		s.RetryBackoff = 0
	}
	if s.MaxSitemapBytes <= 0 {
		s.MaxSitemapBytes = DefaultMaxBodyBytes
	}
	if s.MaxPageBytes <= 0 {
		s.MaxPageBytes = DefaultMaxBodyBytes
	}
	if s.State == nil {
		s.State = NewMemoryStore()
	}
	if s.Fingerprinter == nil {
		s.Fingerprinter = ContentFingerprint
	}
	if s.Clock == nil {
		s.Clock = time.Now
	}
}

func (s *Scheduler) expand(ctx context.Context, roots []string) *Graph {
	graph := &Graph{
		Nodes: make(map[string]*SitemapNode),
	}
	rootSeen := make(map[string]struct{}, len(roots))
	for _, raw := range roots {
		if strings.TrimSpace(raw) == "" {
			graph.Errors = append(graph.Errors, fmt.Errorf("%w: empty root", ErrInvalidURL))
			continue
		}
		root, err := NormalizeURL(raw)
		if err != nil {
			graph.Errors = append(graph.Errors, fmt.Errorf("root %q: %w", raw, err))
			continue
		}
		if _, ok := rootSeen[root]; ok {
			continue
		}
		rootSeen[root] = struct{}{}
		graph.Roots = append(graph.Roots, root)
	}
	if len(graph.Roots) == 0 {
		graph.Errors = append(graph.Errors, ErrNoRoots)
		s.finalizeGraph(graph)
		return graph
	}

	pageIndex := make(map[string]int)
	var visit func(rawURL string, depth int, lastModHint time.Time) bool
	visit = func(rawURL string, depth int, lastModHint time.Time) bool {
		if err := contextErr(ctx); err != nil {
			graph.Errors = append(graph.Errors, err)
			return false
		}
		if node, ok := graph.Nodes[rawURL]; ok {
			switch node.Status {
			case NodeFetching:
				return true
			case NodeComplete:
				return true
			default:
				return false
			}
		}

		node := &SitemapNode{
			URL:     rawURL,
			Depth:   depth,
			Status:  NodeFetching,
			LastMod: lastModHint,
		}
		graph.Nodes[rawURL] = node
		graph.Order = append(graph.Order, rawURL)

		if depth > s.MaxDepth {
			node.Status = NodeFailed
			node.Err = fmt.Errorf("%w: depth %d", ErrMaxDepth, depth)
			graph.Errors = append(graph.Errors, fmt.Errorf("%s: %w", rawURL, node.Err))
			return false
		}

		body, attempts, err := s.fetchBody(ctx, rawURL, s.MaxSitemapBytes)
		node.Attempts = attempts
		if err != nil {
			node.Status = NodeFailed
			node.Err = &FetchError{URL: rawURL, Attempts: attempts, Err: err}
			graph.Errors = append(graph.Errors, node.Err)
			return false
		}

		doc, err := ParseSitemapWithLimit(bytes.NewReader(body), s.MaxSitemapBytes)
		if err != nil {
			node.Status = NodeFailed
			node.Err = &ParseError{URL: rawURL, Err: err}
			graph.Errors = append(graph.Errors, node.Err)
			return false
		}
		node.Kind = doc.Kind

		switch doc.Kind {
		case KindURLSet:
			node.Pages = s.pagesFromURLSet(doc.URLs, node.URL, graph, pageIndex)
			node.Status = NodeComplete
			node.Complete = true
			return true

		case KindIndex:
			allComplete := true
			seenChildren := make(map[string]struct{}, len(doc.Sitemaps))
			for _, ref := range doc.Sitemaps {
				childURL, err := NormalizeURLWithBase(ref.Loc, node.URL)
				if err != nil {
					node.ChildrenTotal++
					allComplete = false
					graph.Errors = append(graph.Errors, fmt.Errorf("sitemap %s: child %q: %w", node.URL, ref.Loc, err))
					continue
				}
				if _, ok := seenChildren[childURL]; ok {
					continue
				}
				seenChildren[childURL] = struct{}{}
				node.Children = append(node.Children, childURL)

				if existing, ok := graph.Nodes[childURL]; ok {
					if existing.Status == NodeFetching {
						node.Cycles = append(node.Cycles, childURL)
						continue
					}
					node.ChildrenTotal++
					if existing.Complete {
						node.ChildrenComplete++
					} else {
						allComplete = false
					}
					continue
				}

				node.ChildrenTotal++
				if visit(childURL, depth+1, ref.LastMod) {
					node.ChildrenComplete++
				} else {
					allComplete = false
				}
			}
			if allComplete {
				node.Status = NodeComplete
				node.Complete = true
				return true
			}
			node.Status = NodeIncomplete
			return false

		default:
			node.Status = NodeFailed
			node.Err = fmt.Errorf("%w: %s", ErrUnsupportedRoot, doc.Kind)
			graph.Errors = append(graph.Errors, &ParseError{URL: rawURL, Err: node.Err})
			return false
		}
	}

	for _, root := range graph.Roots {
		if node, ok := graph.Nodes[root]; ok {
			node.Root = true
			continue
		}
		visit(root, 0, time.Time{})
		if node, ok := graph.Nodes[root]; ok {
			node.Root = true
		}
	}
	s.finalizeGraph(graph)
	return graph
}

func (s *Scheduler) pagesFromURLSet(entries []URLEntry, sitemapURL string, graph *Graph, pageIndex map[string]int) []Page {
	pages := make([]Page, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		canonical, err := NormalizeURLWithBase(entry.Loc, sitemapURL)
		if err != nil {
			graph.Warnings = append(graph.Warnings, fmt.Errorf("sitemap %s: page %q: %w", sitemapURL, entry.Loc, err))
			continue
		}
		if _, ok := seen[canonical]; ok {
			continue
		}
		seen[canonical] = struct{}{}
		page := Page{
			URL:         canonical,
			Loc:         entry.Loc,
			Host:        hostFromCanonical(canonical),
			LastMod:     entry.LastMod,
			LastModRaw:  entry.LastModRaw,
			ChangeFreq:  entry.ChangeFreq,
			Priority:    entry.Priority,
			HasPriority: entry.HasPriority,
			Sitemap:     sitemapURL,
			Sources:     []string{sitemapURL},
		}
		if existing, ok := pageIndex[canonical]; ok {
			merged := &graph.Pages[existing]
			if page.LastMod.After(merged.LastMod) {
				merged.LastMod = page.LastMod
				merged.LastModRaw = page.LastModRaw
			}
			merged.Sources = appendUnique(merged.Sources, sitemapURL)
			pages = append(pages, *merged)
			continue
		}
		pageIndex[canonical] = len(graph.Pages)
		graph.Pages = append(graph.Pages, page)
		pages = append(pages, page)
	}
	return dedupePages(pages)
}

func dedupePages(pages []Page) []Page {
	if len(pages) < 2 {
		return pages
	}
	seen := make(map[string]struct{}, len(pages))
	out := pages[:0]
	for _, page := range pages {
		if _, ok := seen[page.URL]; ok {
			continue
		}
		seen[page.URL] = struct{}{}
		out = append(out, page)
	}
	return out
}

func appendUnique(values []string, value string) []string {
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func hostFromCanonical(canonical string) string {
	u, err := url.Parse(canonical)
	if err != nil {
		return ""
	}
	return u.Host
}

func (s *Scheduler) finalizeGraph(graph *Graph) {
	watermark := Watermark{
		RootsTotal:    len(graph.Roots),
		SitemapsTotal: len(graph.Nodes),
		PagesTotal:    len(graph.Pages),
	}
	for _, node := range graph.Nodes {
		switch node.Status {
		case NodeComplete:
			watermark.SitemapsComplete++
		case NodeFailed:
			watermark.SitemapsFailed++
		case NodeIncomplete:
			watermark.SitemapsIncomplete++
		}
	}
	complete := len(graph.Roots) > 0
	for _, root := range graph.Roots {
		node := graph.Nodes[root]
		if node == nil || !node.Complete {
			complete = false
			continue
		}
		watermark.RootsComplete++
	}
	graph.Complete = complete
	watermark.Complete = complete
	graph.Watermark = watermark
}

func (s *Scheduler) processPages(ctx context.Context, graph *Graph, report *Report) {
	for i := range graph.Pages {
		page := graph.Pages[i]
		if err := contextErr(ctx); err != nil {
			report.Errors = append(report.Errors, err)
			break
		}
		result := PageResult{Page: page}
		content, err := s.pageContent(ctx, page)
		if err != nil {
			result.Err = err
			result.Reason = "content-error"
			report.Results = append(report.Results, result)
			report.Errors = append(report.Errors, fmt.Errorf("page %s: %w", page.URL, err))
			continue
		}
		fingerprint := s.Fingerprinter(content)
		page.Content = content
		page.Fingerprint = fingerprint
		graph.Pages[i] = page
		result.Page = page
		result.Fingerprint = fingerprint

		record, exists, err := s.State.Get(ctx, page.URL)
		if err != nil {
			result.Err = err
			result.Reason = "state-error"
			report.Results = append(report.Results, result)
			report.Errors = append(report.Errors, fmt.Errorf("page %s: %w", page.URL, err))
			continue
		}
		if record.URL == "" {
			record.URL = page.URL
		}
		decision := DecideRevision(record, exists, fingerprint, page.LastMod)
		result.PreviousFingerprint = decision.PreviousFingerprint
		result.Revision = decision.Revision
		result.Changed = decision.Changed
		result.LastModHintOnly = decision.LastModHintOnly
		result.Reason = decision.Reason
		page.Revision = decision.Revision
		graph.Pages[i] = page
		result.Page = page

		if !decision.Publish {
			result.Skipped = true
			report.Results = append(report.Results, result)
			report.Skipped = append(report.Skipped, result)
			continue
		}

		if err := s.Publisher.Publish(ctx, page); err != nil {
			result.Err = err
			result.Reason = "publish-error"
			report.Results = append(report.Results, result)
			report.Errors = append(report.Errors, fmt.Errorf("page %s: %w", page.URL, err))
			continue
		}

		result.Published = true
		if err := s.confirmPage(ctx, page, decision); err != nil {
			result.Err = err
			report.Errors = append(report.Errors, fmt.Errorf("page %s: confirm: %w", page.URL, err))
		}
		report.Results = append(report.Results, result)
		report.Published = append(report.Published, result)
	}
}

func (s *Scheduler) pageContent(ctx context.Context, page Page) ([]byte, error) {
	if s.PageContent != nil {
		return s.PageContent.PageContent(ctx, page)
	}
	if s.DisablePageFetch || (!s.FetchPageContent && s.Publisher == nil) {
		return nil, ErrNoPageContent
	}
	body, _, err := s.fetchBody(ctx, page.URL, s.MaxPageBytes)
	return body, err
}

func (s *Scheduler) confirmPage(ctx context.Context, page Page, decision RevisionDecision) error {
	now := s.Clock()
	record, exists, err := s.State.Get(ctx, page.URL)
	if err != nil {
		return err
	}
	record.URL = page.URL
	if !exists {
		record.FirstSeen = now
	}
	record.Fingerprint = decision.Fingerprint
	record.Revision = decision.Revision
	if record.Revision < 1 {
		record.Revision = 1
	}
	record.LastMod = page.LastMod
	record.Confirmed = true
	record.ConfirmedAt = now
	record.UpdatedAt = now
	return s.State.Put(ctx, record)
}

func (s *Scheduler) fetchBody(ctx context.Context, rawURL string, maxBytes int64) ([]byte, int, error) {
	if s.Fetcher == nil {
		return nil, 0, ErrNoFetcher
	}
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBodyBytes
	}
	attempts := s.MaxAttempts
	if attempts < 1 {
		attempts = 1
	}
	var lastErr error
	used := 0
	for attempt := 1; attempt <= attempts; attempt++ {
		if err := contextErr(ctx); err != nil {
			return nil, used, err
		}
		used = attempt
		data, err := s.Fetcher.Fetch(ctx, rawURL)
		if err == nil {
			if int64(len(data)) > maxBytes {
				return nil, used, fmt.Errorf("%w: limit %d bytes", ErrBodyTooLarge, maxBytes)
			}
			return data, used, nil
		}
		lastErr = err
		if attempt == attempts || !retryableFetchError(err) {
			break
		}
		if err := s.sleepRetry(ctx, attempt); err != nil {
			return nil, used, err
		}
	}
	return nil, used, lastErr
}

func (s *Scheduler) sleepRetry(ctx context.Context, attempt int) error {
	if s.RetryBackoff <= 0 {
		return nil
	}
	delay := s.RetryBackoff
	for i := 1; i < attempt; i++ {
		delay *= 2
		if delay >= 2*time.Second {
			delay = 2 * time.Second
			break
		}
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func retryableFetchError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return false
	}
	var httpErr *HTTPError
	if errors.As(err, &httpErr) {
		switch httpErr.StatusCode {
		case http.StatusRequestTimeout, http.StatusTooEarly, http.StatusTooManyRequests:
			return true
		}
		if httpErr.StatusCode >= 400 && httpErr.StatusCode < 500 {
			return false
		}
	}
	return true
}

// SortedPages returns pages sorted by host and URL. It does not mutate the
// graph.
func SortedPages(pages []Page) []Page {
	out := append([]Page(nil), pages...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Host != out[j].Host {
			return out[i].Host < out[j].Host
		}
		return out[i].URL < out[j].URL
	})
	return out
}
