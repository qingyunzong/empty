// Package dataeng follows a caller-supplied Kubernetes-style watch event
// stream. It does not start watches or listers itself.
//
// A Follower maintains an object cache and a monotonically increasing
// resource version. Resource versions are opaque strings; their ordering is
// defined entirely by the Compare function supplied by the caller.
//
// ADDED, MODIFIED and DELETED events update the cache and produce a Change.
// A BOOKMARK only advances the resource version and never produces an object.
// An ERROR event either reports that a relist is required (ErrExpired) or
// stops the follower by returning the supplied error.
//
// Events whose resource version is older than the last accepted version are
// ignored. A bookmark at the current version is also ignored. Object events at
// the current version are still delivered. Deleting an unknown key reports an
// error and leaves both the cache and the resource version unchanged.
package dataeng
