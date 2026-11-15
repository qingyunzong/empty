// Package robots provides an embeddable robots.txt policy engine for
// multi-tenant crawlers.
//
// The package has four cooperating layers:
//
//   - Parse and Rules evaluate RFC 9309 style user-agent groups, Allow and
//     Disallow rules, wildcard patterns and Crawl-delay directives.
//   - Cache stores immutable policy snapshots per tenant and origin
//     (scheme/host/port), with TTL expiry, a per-origin generation and a
//     cache-wide revision. Conditional writes reject results from an older
//     fetch generation.
//   - Manager resolves robots.txt, applies a configurable fail-open or
//     fail-closed fallback on network or parse failures, and records every
//     important transition through an Auditor.
//   - Claim (also exported as Lease) binds a task to one policy snapshot.
//     Publishing a newer policy revokes claims for the same origin and cancels
//     permits that have not been marked as sent. Permits that were already sent
//     may complete normally, and completed Evidence is append-only.
//
// A typical use is:
//
//	m, _ := robots.NewManager(robots.Config{
//		FailureMode: robots.FailClosed,
//		Auditor:     robots.NewAuditLog(1024),
//	})
//	lease, _ := m.Claim(ctx, robots.Task{
//		Tenant: "tenant-a",
//		URL:    "https://example.com/article/1",
//	})
//	permit, err := lease.Begin(ctx, "/article/1")
//	if err != nil {
//		return err
//	}
//	if err := permit.MarkSent(); err != nil {
//		return err
//	}
//	// Perform the HTTP request using permit.Context().
//	_, err = permit.Complete(robots.Evidence{
//		ID:         "fetch-1",
//		StatusCode: 200,
//	})
package robots
