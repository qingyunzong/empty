export interface ConfigData {
  version: string;
  settings: Record<string, unknown>;
}

export interface Migration {
  id: string;
  from: string;
  to: string;
  up(config: ConfigData): ConfigData;
  down(config: ConfigData): ConfigData;
}

export interface FileAdapter {
  read(path: string): string | null;
  write(path: string, data: string): void;
  delete(path: string): void;
}

export type JournalStatus = 'migrating' | 'rolling-back';

export interface Journal {
  status: JournalStatus;
  from: string;
  target: string;
  path: string[];
  applied: number;
  rollbackIndex: number;
}
