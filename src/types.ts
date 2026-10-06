export type EntryType = "file" | "directory" | "symlink" | "other";

export interface ManifestEntry {
  /** POSIX-style path relative to the scanned root. */
  path: string;
  type: EntryType;
  /** Files only: byte size observed at hash time. */
  size?: number;
  /** Files only: hex sha256 of contents; null when the file could not be read. */
  sha256?: string | null;
  /** Symlinks only: raw link target (never followed). */
  target?: string;
  /** True when the entry changed while being scanned and retries were exhausted. */
  unstable?: boolean;
}

export interface Manifest {
  version: 1;
  entries: ManifestEntry[];
}
