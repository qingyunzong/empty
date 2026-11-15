package dataeng

import "context"

// SitemapScheduler is an alias for Scheduler.
type SitemapScheduler = Scheduler

// NewSitemapScheduler is an alias for NewScheduler.
func NewSitemapScheduler(fetcher Fetcher, opts ...Option) *Scheduler {
	return NewScheduler(fetcher, opts...)
}

// ExpandSitemaps is a package-level convenience wrapper around
// NewScheduler(fetcher, opts...).Expand.
func ExpandSitemaps(ctx context.Context, fetcher Fetcher, roots []string, opts ...Option) (*Graph, error) {
	return NewScheduler(fetcher, opts...).Expand(ctx, roots)
}

// CrawlSitemaps is a package-level convenience wrapper around
// NewScheduler(fetcher, opts...).Run.
func CrawlSitemaps(ctx context.Context, fetcher Fetcher, roots []string, opts ...Option) (*Report, error) {
	return NewScheduler(fetcher, opts...).Run(ctx, roots)
}

// Crawl is an alias for CrawlSitemaps.
func Crawl(ctx context.Context, fetcher Fetcher, roots []string, opts ...Option) (*Report, error) {
	return CrawlSitemaps(ctx, fetcher, roots, opts...)
}
