export class FeatureServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeatureServiceError";
  }
}

/**
 * Raised when a requested version has never been published. A version that is
 * still being staged (backfill in progress) is indistinguishable from an
 * unknown version to readers, so partial versions can never be observed.
 */
export class VersionNotPublishedError extends FeatureServiceError {
  constructor(versionId: string) {
    super(`feature version '${versionId}' is not published`);
    this.name = "VersionNotPublishedError";
  }
}

export class VersionAlreadyPublishedError extends FeatureServiceError {
  constructor(versionId: string) {
    super(`feature version '${versionId}' is already published`);
    this.name = "VersionAlreadyPublishedError";
  }
}
