import {
  buildComposedTree,
  ComposedTreeVersion,
} from "./composed-tree.js";
import type {
  ComposedNode,
  LocateQuery,
  LocateResult,
  LocatorPath,
  SnapshotInput,
} from "./types.js";

function asVersion(
  input: SnapshotInput | ComposedTreeVersion,
): ComposedTreeVersion {
  return input instanceof ComposedTreeVersion
    ? input
    : buildComposedTree(input);
}

export function locateByRoleAndName(
  input: SnapshotInput | ComposedTreeVersion,
  query: LocateQuery | string,
  name?: string,
): LocateResult {
  return asVersion(input).locate(query, name);
}

export function locate(
  input: SnapshotInput | ComposedTreeVersion,
  query: LocateQuery | string,
  name?: string,
): LocateResult {
  return asVersion(input).locate(query, name);
}

export const locateByRoleName = locateByRoleAndName;

export function findAllByRoleAndName(
  input: SnapshotInput | ComposedTreeVersion,
  query: LocateQuery | string,
  name?: string,
): readonly ComposedNode[] {
  return asVersion(input).findAll(query, name);
}

export class RoleNameLocator {
  readonly version: ComposedTreeVersion;

  constructor(input: SnapshotInput | ComposedTreeVersion) {
    this.version = asVersion(input);
  }

  get revision() {
    return this.version.revision;
  }

  locate(query: LocateQuery | string, name?: string): LocateResult {
    return this.version.locate(query, name);
  }

  findAll(
    query: LocateQuery | string,
    name?: string,
  ): readonly ComposedNode[] {
    return this.version.findAll(query, name);
  }

  resolvePath(
    path: LocatorPath | readonly string[] | string | null | undefined,
  ): ComposedNode | undefined {
    return this.version.resolvePath(path);
  }
}

export function createRoleNameLocator(
  input: SnapshotInput | ComposedTreeVersion,
): RoleNameLocator {
  return new RoleNameLocator(input);
}

export const createLocator = createRoleNameLocator;
