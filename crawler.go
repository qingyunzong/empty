package dataeng

import (
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"
)

// Rejection reasons recorded for URLs that the crawler refuses to request.
const (
	// ReasonMalformedURL means the URL could not be parsed or resolved.
	ReasonMalformedURL = "malformed URL"
	// ReasonUnsupportedScheme means the URL scheme is neither http nor https.
	ReasonUnsupportedScheme = "unsupported scheme"
	// ReasonHostNotAllowed means the URL host is not in the allowed host set.
	ReasonHostNotAllowed = "host not allowed"
	// ReasonRedirectAlreadyRequested means a redirect target was already
	// requested, so the redirect chain must stop (e.g. a redirect loop).
	ReasonRedirectAlreadyRequested = "redirect target already requested"
)

// Reject records a URL that was discovered but never requested.
type Reject struct {
	// URL is the raw URL as discovered (an href value or redirect location).
	URL string
	// Reason is one of the Reason* constants.
	Reason string
}

// Visit records one crawl request chain: the initial request URL, the final
// response URL after following redirects, and the outcome.
type Visit struct {
	// RequestURL is the URL that started the request chain.
	RequestURL string
	// FinalURL is the URL of the final response (equal to RequestURL when no
	// redirects were followed).
	FinalURL string
	// StatusCode is the final response status code; zero when no response was
	// received.
	StatusCode int
	// Error holds the transport error, if any.
	Error error
	// Links are the href values found on the final page in document order.
	// Links are only extracted from successful HTML responses.
	Links []string
}

// Edge is a reference from a crawled page (From, the final response URL) to a
// discovered link (To, the canonicalized absolute URL).
type Edge struct {
	From string
	To   string
}

// Result is the output of a crawl.
type Result struct {
	// Visits are request chains in the order they were started, which is
	// breadth-first order.
	Visits []Visit
	// Edges are reference relationships discovered on successful HTML pages.
	Edges []Edge
	// Rejects are discovered URLs that were never requested with the reason.
	Rejects []Reject
	// Pending is the breadth-first queue of canonical URLs not yet processed.
	Pending []string
	// PendingRedirects are redirect targets that could not be requested,
	// typically because the request limit was reached mid-redirect-chain.
	PendingRedirects []string
}

// Crawler performs bounded breadth-first site crawls. The zero value is not
// usable; create one with NewCrawler.
type Crawler struct {
	transport http.RoundTripper
}

// NewCrawler creates a Crawler using transport for all HTTP requests. A nil
// transport defaults to http.DefaultTransport, which keeps the transport layer
// replaceable (for example with a recording or mock transport).
func NewCrawler(transport http.RoundTripper) *Crawler {
	if transport == nil {
		transport = http.DefaultTransport
	}
	return &Crawler{transport: transport}
}

type queueItem struct {
	url       string
	processed bool
}

// Crawl starts at startURL, only requesting URLs whose host is in allowedHosts
// (host comparison is case-insensitive and ignores ports), and performs at most
// limit HTTP requests. Every request, including redirect follows, counts.
func (c *Crawler) Crawl(startURL string, allowedHosts map[string]bool, limit int) *Result {
	result := &Result{}
	if limit <= 0 {
		return result
	}

	allowed := make(map[string]bool, len(allowedHosts))
	for host := range allowedHosts {
		if hostname, _, err := net.SplitHostPort(host); err == nil {
			host = hostname
		}
		allowed[strings.ToLower(host)] = true
	}

	requested := map[string]bool{}
	enqueued := map[string]bool{}
	queueIndex := map[string]int{}
	var queue []queueItem

	enqueue := func(rawURL string) {
		canonical, reason := canonicalize(rawURL)
		if reason != "" {
			result.Rejects = append(result.Rejects, Reject{URL: rawURL, Reason: reason})
			return
		}
		parsed, err := url.Parse(canonical)
		if err != nil || !allowed[parsed.Hostname()] {
			result.Rejects = append(result.Rejects, Reject{URL: rawURL, Reason: ReasonHostNotAllowed})
			return
		}
		if requested[canonical] || enqueued[canonical] {
			return
		}
		enqueued[canonical] = true
		queueIndex[canonical] = len(queue)
		queue = append(queue, queueItem{url: canonical})
	}

	enqueue(startURL)

	requests := 0
	for head := 0; head < len(queue); head++ {
		item := queue[head]
		if item.processed {
			continue
		}
		if requests >= limit {
			break
		}
		visit := c.follow(item.url, allowed, limit, &requests, requested, enqueued, queueIndex, queue, result)
		result.Visits = append(result.Visits, Visit{
			RequestURL: visit.RequestURL,
			FinalURL:   visit.FinalURL,
			StatusCode: visit.StatusCode,
			Error:      visit.Error,
			Links:      visit.Links,
		})
		for _, rawHref := range visit.Links {
			base, parseErr := url.Parse(visit.FinalURL)
			if parseErr != nil {
				result.Rejects = append(result.Rejects, Reject{URL: rawHref, Reason: ReasonMalformedURL})
				continue
			}
			linkURL, parseErr := url.Parse(rawHref)
			if parseErr != nil {
				result.Rejects = append(result.Rejects, Reject{URL: rawHref, Reason: ReasonMalformedURL})
				continue
			}
			resolved := base.ResolveReference(linkURL).String()
			canonical, reason := canonicalize(resolved)
			if reason != "" {
				result.Rejects = append(result.Rejects, Reject{URL: rawHref, Reason: reason})
				continue
			}
			result.Edges = append(result.Edges, Edge{From: visit.FinalURL, To: canonical})
			enqueue(canonical)
		}
	}

	for _, item := range queue {
		if !item.processed {
			result.Pending = append(result.Pending, item.url)
		}
	}
	return result
}

// follow issues one request chain for targetURL, following redirects in order.
// It mutates the shared crawl state (request counters, queue flags, rejects and
// pending redirects) and returns the Visit describing the chain.
func (c *Crawler) follow(
	targetURL string,
	allowed map[string]bool,
	limit int,
	requests *int,
	requested map[string]bool,
	enqueued map[string]bool,
	queueIndex map[string]int,
	queue []queueItem,
	result *Result,
) Visit {
	visit := Visit{RequestURL: targetURL}
	current := targetURL

	client := &http.Client{
		Transport: c.transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	for {
		// State and policy checks happen before every request, including each
		// redirect follow.
		if requested[current] {
			result.Rejects = append(result.Rejects, Reject{URL: current, Reason: ReasonRedirectAlreadyRequested})
			break
		}
		if index, ok := queueIndex[current]; ok && enqueued[current] {
			queue[index].processed = true
		}
		parsedCurrent, parseErr := url.Parse(current)
		if parseErr != nil || !allowed[parsedCurrent.Hostname()] {
			result.Rejects = append(result.Rejects, Reject{URL: current, Reason: ReasonHostNotAllowed})
			break
		}
		if *requests >= limit {
			result.PendingRedirects = append(result.PendingRedirects, current)
			break
		}

		requested[current] = true
		*requests++

		response, err := client.Get(current)
		if err != nil {
			visit.FinalURL = current
			visit.Error = err
			break
		}

		body, readErr := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		visit.StatusCode = response.StatusCode
		finalCanonical, reason := canonicalize(response.Request.URL.String())
		if reason != "" {
			result.Rejects = append(result.Rejects, Reject{URL: response.Request.URL.String(), Reason: reason})
			break
		}
		visit.FinalURL = finalCanonical
		current = finalCanonical

		if readErr != nil {
			visit.Error = readErr
			break
		}
		if closeErr != nil {
			visit.Error = closeErr
			break
		}

		location, redirected := redirectLocation(response)
		if !redirected {
			if response.StatusCode >= 200 && response.StatusCode < 300 && isHTML(response.Header) {
				visit.Links = extractLinks(body)
			}
			break
		}

		target, parseErr := url.Parse(location)
		if parseErr != nil {
			result.Rejects = append(result.Rejects, Reject{URL: location, Reason: ReasonMalformedURL})
			break
		}
		base, parseErr := url.Parse(current)
		if parseErr != nil {
			result.Rejects = append(result.Rejects, Reject{URL: location, Reason: ReasonMalformedURL})
			break
		}
		resolved := base.ResolveReference(target).String()
		canonical, reason := canonicalize(resolved)
		if reason != "" {
			result.Rejects = append(result.Rejects, Reject{URL: location, Reason: reason})
			break
		}
		current = canonical
	}
	return visit
}

// canonicalize normalizes a raw absolute URL for deduplication: the scheme must
// be http or https, the host is lowercased, and fragments are removed. The
// returned reason is empty on success.
func canonicalize(rawURL string) (string, string) {
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", ReasonMalformedURL
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", ReasonUnsupportedScheme
	}
	if parsed.Host == "" {
		return "", ReasonMalformedURL
	}
	parsed.Host = lowerHostname(parsed.Host)
	parsed.Fragment = ""
	parsed.RawFragment = ""
	return parsed.String(), ""
}

// lowerHostname lowercases the hostname portion while leaving an optional
// port separator and port untouched.
func lowerHostname(host string) string {
	if hostname, port, err := net.SplitHostPort(host); err == nil {
		return net.JoinHostPort(strings.ToLower(hostname), port)
	}
	return strings.ToLower(host)
}

func redirectLocation(response *http.Response) (string, bool) {
	if response.StatusCode < 300 || response.StatusCode >= 400 {
		return "", false
	}
	location := response.Header.Get("Location")
	if location == "" {
		return "", false
	}
	return location, true
}

func isHTML(header http.Header) bool {
	contentType := header.Get("Content-Type")
	if contentType == "" {
		return false
	}
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	return mediaType == "text/html"
}
