/** 一条策略规则：决议（decision）与来源（source）是必须可完全恢复的字段。 */
export interface Rule {
    id: string;
    decision: string;
    source: string;
}
/** 规则摘要：随差分条目记录，携带完整决议与来源以及内容哈希。 */
export interface RuleSummary {
    id: string;
    decision: string;
    source: string;
    hash: string;
}
export type DiffOp = "add" | "delete" | "update";
/** 差分条目：同一规则的前摘要（before）与后摘要（after）。 */
export interface DiffEntry {
    ruleId: string;
    op: DiffOp;
    before: RuleSummary | null;
    after: RuleSummary | null;
}
/** 差分：一组条目 + 应用前后两个快照的摘要指纹。 */
export interface Diff {
    entries: DiffEntry[];
    fromDigest: string;
    toDigest: string;
}
export type BatchOp = {
    type: "put";
    rule: Rule;
} | {
    type: "delete";
    ruleId: string;
};
/** 不可变版本：追加式写入，历史版本永不修改。 */
export interface Version {
    id: number;
    digest: string;
    parent: number | null;
    diff: Diff;
}
export declare class DiffVerificationError extends Error {
    constructor(message: string);
}
export declare function summarizeRule(rule: Rule): RuleSummary;
/** 规则集合的内容指纹：与插入顺序无关。 */
export declare function digestOf(rules: ReadonlyMap<string, Readonly<Rule>>): string;
/**
 * 先核后放：在基底副本上校验并应用差分。
 * 任一前置摘要不匹配、或结果指纹不符，都抛 DiffVerificationError，基底不被改动。
 */
export declare function applyDiffChecked(base: ReadonlyMap<string, Readonly<Rule>>, diff: Diff): Map<string, Readonly<Rule>>;
/** 逆差分：条目倒序、前后摘要互换，用于逆发布。 */
export declare function invertDiff(diff: Diff): Diff;
/** 差分复合：first 之后接 second，净效果合并为单个差分；净无变化的条目被消去。 */
export declare function composeDiffs(first: Diff, second: Diff): Diff;
/** 读者快照：私有副本 + 冻结规则，热更不影响已持有的快照。 */
export declare class Snapshot {
    readonly versionId: number;
    readonly digest: string;
    private readonly rules;
    constructor(versionId: number, digest: string, rules: ReadonlyMap<string, Readonly<Rule>>);
    get size(): number;
    has(ruleId: string): boolean;
    getRule(ruleId: string): Readonly<Rule> | undefined;
    decide(ruleId: string): string | undefined;
    listRules(): Readonly<Rule>[];
}
/**
 * 策略库：追加式版本日志。
 * - 批增删发布生成带前后摘要的差分；
 * - 逆发布先核后像，失败则历史不变；
 * - 历史版本只读，永不修改。
 */
export declare class StrategyLibrary {
    private readonly versions;
    private readonly states;
    constructor();
    get head(): Version;
    get versionCount(): number;
    getVersion(id: number): Version;
    /** 读者快照：默认取当前头版本；返回独立副本，与后续热更隔离。 */
    getSnapshot(versionId?: number): Snapshot;
    /** 批量增删改发布：生成带前后摘要的差分，追加新版本，历史不变。 */
    publish(ops: BatchOp[]): Version;
    /**
     * 逆发布：先核后像。
     * 核：把当前到头目标版本的差分链求逆，在临时副本上重放，
     *     校验结果指纹与目标历史版本一致（决议与来源完全恢复）；
     * 像：校验通过后才追加新版本；任何不一致都抛错且历史不变。
     */
    inversePublish(targetVersionId: number): Version;
    private commit;
}
