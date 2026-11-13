// Package dataeng provides an in-memory S3 version inventory state store.
//
// A Store ingests ListObjectVersions pages in staging generations. Pages are
// merged by (key, version ID), so retries and overlapping pages are idempotent.
// Nothing becomes visible to readers until the complete traversal is published
// as an immutable Snapshot. A published Snapshot exposes two views:
//
//   - the latest view contains one live version per key and omits keys whose
//     newest entry is a delete marker;
//   - the history view contains every known version and delete marker, newest
//     first, including keys that are currently deleted.
//
// Uploads and delete markers observed while a traversal is running can be
// recorded with Store.RecordUpload and Store.RecordDeleteMarker. They are
// merged into the next published snapshot, which makes a snapshot include
// versions that were concurrently written after their keys had already been
// paged over.
package dataeng
