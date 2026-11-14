export {
  classifyResponse,
  isFreshNetworkEvidence,
  type Classification,
  type ResponseEvidence,
  type ResponseSource,
} from "./src/response-source.ts";

export {
  BypassError,
  createDocumentGeneration,
  verifyFreshNetworkEvidence,
  waitForSwLoseControl,
  type BrowserEnv,
  type BypassOptions,
  type BypassVerification,
} from "./src/sw-bypass.ts";
