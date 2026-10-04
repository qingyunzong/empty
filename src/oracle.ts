export type Verdict = "good" | "bad";

export interface Oracle {
  test(version: string): Verdict | Promise<Verdict>;
}

export class OracleError extends Error {
  readonly version: string;
  constructor(version: string, message: string) {
    super(message);
    this.name = "OracleError";
    this.version = version;
  }
}

export type ScriptedVerdict = Verdict | "error";

export function fromMap(script: Record<string, ScriptedVerdict>): Oracle {
  return {
    test(version: string): Verdict {
      const entry = script[version];
      if (entry === undefined) {
        throw new OracleError(version, `no scripted verdict for version "${version}"`);
      }
      if (entry === "error") {
        throw new OracleError(version, `scripted detector failure on version "${version}"`);
      }
      return entry;
    },
  };
}

export function withFailures(base: Oracle, shouldFail: (version: string) => boolean): Oracle {
  return {
    async test(version: string): Promise<Verdict> {
      if (shouldFail(version)) {
        throw new OracleError(version, `detector crashed on version "${version}"`);
      }
      return base.test(version);
    },
  };
}
