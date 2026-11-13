// Package dataeng decides whether an incrementally fetched representation may
// keep its previously stored body after a conditional revalidation. It never
// performs any network I/O: callers build conditional request headers before
// a request and interpret the paired stored/latest responses afterwards.
//
// Entity-tag handling follows RFC 9110 section 8.8: a strong validator
// satisfies weak comparison, while a weak validator never satisfies the
// strong comparison used for range requests. A wildcard only matches when a
// representation body is already held. Reusing a 304 Not Modified response
// keeps the stored payload and merges only date, validator and cache headers;
// the new response's body length is never adopted.
package dataeng
