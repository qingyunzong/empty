export type TieGroup = string[];

export interface CategoryNodeInput {
  id: string;
  quota: number;
  children?: CategoryNodeInput[];
}

export interface ApplicantInput {
  id: string;
  categories?: string[];
  prefers: TieGroup[];
}

export interface InstitutionInput {
  id: string;
  capacity: number;
  quotas?: CategoryNodeInput[];
  prefers: TieGroup[];
}

export interface MarketInput {
  applicants: ApplicantInput[];
  institutions: InstitutionInput[];
}
