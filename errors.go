package dataeng

import (
	"errors"
	"fmt"
	"strings"
)

var (
	// ErrEmptyDocument is returned when a sitemap contains no XML root.
	ErrEmptyDocument = errors.New("sitemap: empty document")
	// ErrUnsupportedRoot is returned for an XML document that is neither a
	// urlset nor a sitemapindex.
	ErrUnsupportedRoot = errors.New("sitemap: unsupported root element")
	// ErrBodyTooLarge is returned when a downloaded or decompressed body
	// exceeds the configured limit.
	ErrBodyTooLarge = errors.New("sitemap: body too large")
	// ErrInvalidURL is returned when a location cannot be represented as an
	// absolute hierarchical URL.
	ErrInvalidURL = errors.New("sitemap: invalid URL")
	// ErrNoFetcher is returned when network access is required but no Fetcher
	// was configured.
	ErrNoFetcher = errors.New("sitemap: no fetcher configured")
	// ErrNoPageContent is returned when a publisher needs page content but no
	// content provider and no page fetching was configured.
	ErrNoPageContent = errors.New("sitemap: page content is not available")
	// ErrMaxDepth is returned when the sitemap index chain exceeds MaxDepth.
	ErrMaxDepth = errors.New("sitemap: maximum index depth exceeded")
	// ErrNoRoots is returned when a run has no usable sitemap root.
	ErrNoRoots = errors.New("sitemap: no roots supplied")
)

// ParseError identifies the sitemap that failed to parse.
type ParseError struct {
	URL string
	Err error
}

func (e *ParseError) Error() string {
	if e.URL == "" {
		return fmt.Sprintf("sitemap: parse: %v", e.Err)
	}
	return fmt.Sprintf("sitemap: parse %s: %v", e.URL, e.Err)
}

func (e *ParseError) Unwrap() error { return e.Err }

// FetchError identifies the sitemap or page that could not be downloaded.
type FetchError struct {
	URL      string
	Attempts int
	Err      error
}

func (e *FetchError) Error() string {
	if e.Attempts > 1 {
		return fmt.Sprintf("sitemap: fetch %s after %d attempts: %v", e.URL, e.Attempts, e.Err)
	}
	return fmt.Sprintf("sitemap: fetch %s: %v", e.URL, e.Err)
}

func (e *FetchError) Unwrap() error { return e.Err }

// HTTPError is returned by HTTPFetcher for non-successful HTTP status codes.
type HTTPError struct {
	URL        string
	StatusCode int
	Status     string
}

func (e *HTTPError) Error() string {
	status := e.Status
	if status == "" {
		status = fmt.Sprintf("%d", e.StatusCode)
	}
	return fmt.Sprintf("sitemap: GET %s: HTTP %s", e.URL, status)
}

// MultiError aggregates independent failures so one broken sitemap branch does
// not hide errors from another branch.
type MultiError struct {
	Errors []error
}

func (e *MultiError) Error() string {
	if e == nil || len(e.Errors) == 0 {
		return ""
	}
	parts := make([]string, 0, len(e.Errors))
	for _, err := range e.Errors {
		if err != nil {
			parts = append(parts, err.Error())
		}
	}
	return strings.Join(parts, "; ")
}

// Unwrap supports errors.Is/errors.As across all aggregated errors.
func (e *MultiError) Unwrap() []error {
	if e == nil {
		return nil
	}
	out := make([]error, 0, len(e.Errors))
	for _, err := range e.Errors {
		if err != nil {
			out = append(out, err)
		}
	}
	return out
}

// NewMultiError returns nil when no non-nil errors are supplied.
func NewMultiError(errs ...error) error {
	nonNil := make([]error, 0, len(errs))
	for _, err := range errs {
		if err != nil {
			nonNil = append(nonNil, err)
		}
	}
	switch len(nonNil) {
	case 0:
		return nil
	case 1:
		return nonNil[0]
	default:
		return &MultiError{Errors: nonNil}
	}
}

// AsMultiError exposes an aggregated error as a slice.
func AsMultiError(err error, dst *[]error) bool {
	var multi *MultiError
	if !errors.As(err, &multi) {
		return false
	}
	*dst = append(*dst, multi.Errors...)
	return true
}
