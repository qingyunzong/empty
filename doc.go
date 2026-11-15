// Package dataeng provides a small, dependency-free sitemap scheduler for
// search collection pipelines.
//
// The package intentionally separates three concerns:
//
//   - Sitemap discovery: sitemap indexes, gzip encoded sitemaps, relative
//     locations, cycles and duplicate references are expanded into a graph.
//   - URL identity: locations are resolved and canonicalized on a per-host
//     basis before they are de-duplicated.
//   - Revision identity: sitemap lastmod values are hints only; a page is
//     republished only when the fingerprint of its content changes.
//
// A Scheduler keeps completion and publication state idempotent. A parent
// sitemap is complete only after every non-cyclic child sitemap completed
// successfully. Retrying a failed child therefore never advances the parent
// completion watermark, and pages that were already confirmed are not emitted
// again.
package dataeng
