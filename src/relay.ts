export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface Edge<T> {
  node: T;
  cursor: string;
}

export interface Connection<T> {
  edges: Array<Edge<T>>;
  pageInfo: PageInfo;
}

export interface VersionedNode {
  id: string;
  version: number;
}

export type FetchPage<T extends VersionedNode> = (
  after: string | null,
  first: number,
) => Promise<Connection<T>>;
