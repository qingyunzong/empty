export type EntryType = 'file' | 'directory' | 'symlink' | 'other';

/**
 * Evidence that a file's content has not changed. A cached hash is reused
 * only when every field matches a fresh lstat. ctimeMs and ino cannot be
 * forged by user-space tools (utimes etc.), which prevents false cache hits
 * when content is rewritten with the same size and a restored mtime.
 */
export interface ContentEvidence {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

export interface ManifestEntry {
  /** POSIX-style path relative to the scanned root. */
  path: string;
  type: EntryType;
  /** sha256 hex digest; present for files only. */
  hash?: string;
  /** True when the file kept changing while being hashed. */
  unstable?: boolean;
  /** lstat evidence captured at hash time; used for cache reuse. */
  evidence?: ContentEvidence;
  /** Raw symlink target (symlinks are never followed). */
  linkTarget?: string;
}

export interface Manifest {
  version: 1;
  root: string;
  createdAt: string;
  /** Sorted by path. */
  entries: ManifestEntry[];
}
