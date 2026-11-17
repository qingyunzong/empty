// Package formal provides an embeddable, in-process circuit breaker for API
// gateways. Group maintains independent sliding windows for routes and upstream
// instances, while sharing one half-open probe budget across both layers of a
// route.
//
// Rejected requests never enter a statistics window. In particular, a request
// rejected by an ejected instance cannot increase the route failure count.
package formal
