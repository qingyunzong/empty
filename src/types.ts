export type NodeId = string;

export interface EdgeInput {
  from: string | number;
  to: string | number;
  cost: number;
}

export interface GraphInput {
  nodes?: Array<string | number>;
  edges: EdgeInput[];
  start: string | number;
  end: string | number;
  checkpoints?: Array<string | number>;
  maxNodes?: number;
  directed?: boolean;
}

export interface PathWitness {
  found: boolean;
  path: NodeId[];
  maxEdgeCost: number | null;
  totalCost: number | null;
  nodeCount: number;
  checkpoints: NodeId[];
  maxNodes: number;
}
