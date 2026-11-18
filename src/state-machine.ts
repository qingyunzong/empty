import { IllegalTransitionError } from "./errors.ts";

export const ClientState = {
  Start: "start",
  InitialHelloSent: "initial_hello_sent",
  RetryHelloSent: "retry_hello_sent",
  WaitEncryptedExtensions: "wait_encrypted_extensions",
  WaitCertificate: "wait_certificate",
  WaitCertificateVerify: "wait_certificate_verify",
  WaitServerFinished: "wait_server_finished",
  FinishedSent: "finished_sent",
  Connected: "connected",
  Failed: "failed",
} as const;

export type ClientState = typeof ClientState[keyof typeof ClientState];

export const ClientEvent = {
  Start: "START",
  ConfirmSent: "CONFIRM_SENT",
  SendEarlyData: "SEND_EARLY_DATA",
  ReceiveHelloRetryRequest: "RECEIVE_HELLO_RETRY_REQUEST",
  ReceiveServerHello: "RECEIVE_SERVER_HELLO",
  ReceiveEncryptedExtensions: "RECEIVE_ENCRYPTED_EXTENSIONS",
  ReceiveCertificate: "RECEIVE_CERTIFICATE",
  ReceiveCertificateVerify: "RECEIVE_CERTIFICATE_VERIFY",
  ReceiveFinished: "RECEIVE_FINISHED",
  ReceiveNewSessionTicket: "RECEIVE_NEW_SESSION_TICKET",
  Resend: "RESEND",
  Fail: "FAIL",
} as const;

export type ClientEvent = typeof ClientEvent[keyof typeof ClientEvent];

export const ServerState = {
  Start: "start",
  WaitClientHello: "wait_client_hello",
  WaitSecondClientHello: "wait_second_client_hello",
  WaitClientFinished: "wait_client_finished",
  Connected: "connected",
  Failed: "failed",
} as const;

export type ServerState = typeof ServerState[keyof typeof ServerState];

export const ServerEvent = {
  Start: "START",
  ConfirmSent: "CONFIRM_SENT",
  ReceiveClientHello: "RECEIVE_CLIENT_HELLO",
  ReceiveClientHelloRetry: "RECEIVE_CLIENT_HELLO_RETRY",
  ReceiveSecondClientHello: "RECEIVE_SECOND_CLIENT_HELLO",
  ReceiveDuplicateClientHello: "RECEIVE_DUPLICATE_CLIENT_HELLO",
  ReceiveEarlyData: "RECEIVE_EARLY_DATA",
  ReceiveEndOfEarlyData: "RECEIVE_END_OF_EARLY_DATA",
  ReceiveFinished: "RECEIVE_FINISHED",
  Resend: "RESEND",
  Fail: "FAIL",
} as const;

export type ServerEvent = typeof ServerEvent[keyof typeof ServerEvent];

export type TransitionTable<S extends string, E extends string> = {
  readonly [State in S]: Partial<Record<E, S>>;
};

export const CLIENT_TRANSITIONS: TransitionTable<ClientState, ClientEvent> = {
  start: {
    START: "initial_hello_sent",
  },
  initial_hello_sent: {
    CONFIRM_SENT: "initial_hello_sent",
    SEND_EARLY_DATA: "initial_hello_sent",
    RECEIVE_HELLO_RETRY_REQUEST: "retry_hello_sent",
    RECEIVE_SERVER_HELLO: "wait_encrypted_extensions",
    RESEND: "initial_hello_sent",
  },
  retry_hello_sent: {
    CONFIRM_SENT: "retry_hello_sent",
    RECEIVE_SERVER_HELLO: "wait_encrypted_extensions",
    RESEND: "retry_hello_sent",
  },
  wait_encrypted_extensions: {
    CONFIRM_SENT: "wait_encrypted_extensions",
    RECEIVE_ENCRYPTED_EXTENSIONS: "wait_certificate",
  },
  wait_certificate: {
    CONFIRM_SENT: "wait_certificate",
    RECEIVE_CERTIFICATE: "wait_certificate_verify",
  },
  wait_certificate_verify: {
    CONFIRM_SENT: "wait_certificate_verify",
    RECEIVE_CERTIFICATE_VERIFY: "wait_server_finished",
  },
  wait_server_finished: {
    CONFIRM_SENT: "wait_server_finished",
    RECEIVE_FINISHED: "finished_sent",
  },
  finished_sent: {
    CONFIRM_SENT: "connected",
    RESEND: "finished_sent",
  },
  connected: {
    CONFIRM_SENT: "connected",
    RECEIVE_NEW_SESSION_TICKET: "connected",
    RESEND: "connected",
  },
  failed: {},
};

export const SERVER_TRANSITIONS: TransitionTable<ServerState, ServerEvent> = {
  start: {
    START: "wait_client_hello",
  },
  wait_client_hello: {
    CONFIRM_SENT: "wait_client_hello",
    RECEIVE_CLIENT_HELLO: "wait_client_finished",
    RECEIVE_CLIENT_HELLO_RETRY: "wait_second_client_hello",
    RESEND: "wait_client_hello",
  },
  wait_second_client_hello: {
    CONFIRM_SENT: "wait_second_client_hello",
    RECEIVE_SECOND_CLIENT_HELLO: "wait_client_finished",
    RECEIVE_DUPLICATE_CLIENT_HELLO: "wait_second_client_hello",
    RESEND: "wait_second_client_hello",
  },
  wait_client_finished: {
    CONFIRM_SENT: "wait_client_finished",
    RECEIVE_DUPLICATE_CLIENT_HELLO: "wait_client_finished",
    RECEIVE_EARLY_DATA: "wait_client_finished",
    RECEIVE_END_OF_EARLY_DATA: "wait_client_finished",
    RECEIVE_FINISHED: "connected",
    RESEND: "wait_client_finished",
  },
  connected: {
    CONFIRM_SENT: "connected",
    RECEIVE_EARLY_DATA: "connected",
    RECEIVE_END_OF_EARLY_DATA: "connected",
    RESEND: "connected",
  },
  failed: {},
};

export interface StateHistoryEntry<E extends string> {
  readonly state: string;
  readonly event: E | "INIT";
  readonly at: number;
}

export function transitionState<S extends string, E extends string>(
  table: TransitionTable<S, E>,
  state: S,
  event: E,
  failedState: S,
): S {
  if (event === "FAIL") return failedState;
  const next = table[state][event];
  if (next === undefined) {
    throw new IllegalTransitionError(state, event);
  }
  return next;
}

export function isFailedState(state: string): boolean {
  return state === "failed";
}
