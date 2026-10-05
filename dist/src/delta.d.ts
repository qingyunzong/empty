/** 版本差量：每项声明其父版本（根版本 parentId 为 null）。 */
export interface Delta {
    id: string;
    parentId: string | null;
    payload: Record<string, unknown>;
    /** 对 payload 的 sha256 摘要（十六进制），用于坏摘要检测。 */
    checksum: string;
}
/** 稳定序列化：对象键排序，保证同一 payload 摘要确定。 */
export declare function canonicalize(value: unknown): string;
export declare function computeChecksum(payload: unknown): string;
/** 构造一条差量并自动计算摘要。 */
export declare function makeDelta(id: string, parentId: string | null, payload: Record<string, unknown>): Delta;
