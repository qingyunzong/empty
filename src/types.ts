export interface PersonInput {
  id: string | number;
  skills?: string[];
  cost: number;
}

export interface InstanceInput {
  people: PersonInput[];
  forbiddenPairs?: Array<[string | number, string | number]>;
  minSkills?: Record<string, number>;
}

export interface Person {
  id: string;
  skills: string[];
  cost: number;
  skillMask: number;
}

export interface Instance {
  people: Person[];
  skills: string[];
  required: number[];
  forbiddenPairs: Array<[number, number]>;
  forbiddenMask: number[];
}

export interface Candidate {
  cost: number;
  size: number;
  ids: string[];
  indices: number[];
}
