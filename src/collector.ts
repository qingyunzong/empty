import { DownloadAttributor } from "./attribution.ts";
import type {
  BrowserCapture,
  DownloadAttribution,
  DownloadAttributorOptions,
  DownloadEventInput,
  EventId,
  FileCompletionInput,
  NetworkResponse,
  NetworkResponseInput,
  Popup,
  PopupInput,
  PopupNavigationInput,
  UserAction,
  UserActionInput,
} from "./types.ts";

/**
 * Thin integration surface for browser-extension / content-script capture.
 *
 * The collector source is responsible only for translating browser APIs into
 * these records. Attribution, causality checks, claim locking, and on-disk
 * verification remain in the platform-neutral engine.
 */
export class BrowserDownloadCollector extends DownloadAttributor {
  constructor(options: DownloadAttributorOptions = {}) {
    super(options);
  }

  trackAction(input: UserActionInput): UserAction {
    return this.recordAction(input);
  }

  trackUserAction(input: UserActionInput): UserAction {
    return this.recordAction(input);
  }

  captureAction(input: UserActionInput): UserAction {
    return this.recordAction(input);
  }

  trackPopup(input: PopupInput): Popup {
    return this.recordPopup(input);
  }

  capturePopup(input: PopupInput): Popup {
    return this.recordPopup(input);
  }

  trackPopupNavigation(
    popupId: EventId,
    input: PopupNavigationInput,
  ): Popup | undefined {
    return this.recordPopupNavigation(popupId, input);
  }

  trackResponse(input: NetworkResponseInput): NetworkResponse {
    return this.recordResponse(input);
  }

  captureResponse(input: NetworkResponseInput): NetworkResponse {
    return this.recordResponse(input);
  }

  trackDownload(input: DownloadEventInput): DownloadAttribution {
    return this.recordDownload(input);
  }

  captureDownload(input: DownloadEventInput): DownloadAttribution {
    return this.recordDownload(input);
  }

  completeFile(input: FileCompletionInput): Promise<DownloadAttribution> {
    return this.recordFile(input);
  }

  captureFile(input: FileCompletionInput): Promise<DownloadAttribution> {
    return this.recordFile(input);
  }

  override ingest(
    event: BrowserCapture,
  ): Promise<DownloadAttribution | undefined> {
    return super.ingest(event);
  }
}

export function createBrowserDownloadCollector(
  options: DownloadAttributorOptions = {},
): BrowserDownloadCollector {
  return new BrowserDownloadCollector(options);
}

export function createDownloadAttributor(
  options: DownloadAttributorOptions = {},
): DownloadAttributor {
  return new DownloadAttributor(options);
}

/**
 * Batch helper for collectors that already buffer browser events. Events are
 * ingested in their provided order; observation timestamps still decide
 * causality.
 */
export async function attributeDownloads(
  events: readonly BrowserCapture[],
  options: DownloadAttributorOptions = {},
): Promise<DownloadAttribution[]> {
  const collector = new BrowserDownloadCollector(options);
  for (const event of events) {
    await collector.ingest(event);
  }
  return collector.list();
}

export { BrowserDownloadCollector as DownloadCollector };
