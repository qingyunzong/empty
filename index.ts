export * from "./src/errors.ts";
export * from "./src/journal.ts";
export * from "./src/keys.ts";
export * from "./src/snapshot.ts";
export * from "./src/store.ts";
export * from "./src/types.ts";
export {
  TableSelectionController,
  createTableSelectionController,
  defineTableAdapter,
  runSelection,
  runTableSelection,
} from "./src/controller.ts";
export type {
  RunTableSelectionOptions,
  SelectionTarget,
} from "./src/controller.ts";

export {
  TableSelectionStore,
  TableSelectionStore as SelectionStore,
  TableSelectionStore as SelectionState,
  TableSelectionStore as TableSelectionState,
  TableSelectionStore as CrossPageSelectionStore,
  TableSelectionStore as CrossPageSelection,
  TableSelectionStore as PagedSelectionStore,
} from "./src/store.ts";

export {
  TableSelectionController as SelectionController,
  TableSelectionController as TableSelectionRunner,
  TableSelectionController as RpaTableSelection,
  TableSelectionController as TableSelectionAutomation,
} from "./src/controller.ts";

import {
  TableSelectionController,
  createTableSelectionController,
  runTableSelection,
} from "./src/controller.ts";
import { TableSelectionStore } from "./src/store.ts";
import type {
  SelectionControllerOptions,
  SelectionStoreOptions,
} from "./src/types.ts";

export function createTableSelectionStore<Row extends object = Record<string, unknown>>(
  options: SelectionStoreOptions<Row> | string = {},
): TableSelectionStore<Row> {
  return new TableSelectionStore<Row>(options);
}

export const createSelectionStore = createTableSelectionStore;
export const createSelectionState = createTableSelectionStore;
export const createSelection = createTableSelectionStore;

export function createTableSelection<Row extends object = Record<string, unknown>>(
  options: SelectionControllerOptions<Row>,
): TableSelectionController<Row>;
export function createTableSelection<Row extends object = Record<string, unknown>>(
  options?: SelectionStoreOptions<Row> | string,
): TableSelectionStore<Row>;
export function createTableSelection<Row extends object = Record<string, unknown>>(
  options: SelectionControllerOptions<Row> | SelectionStoreOptions<Row> | string = {},
):
  | TableSelectionController<Row>
  | TableSelectionStore<Row> {
  if (
    typeof options === "object" &&
    options !== null &&
    "adapter" in options &&
    options.adapter !== undefined
  ) {
    return new TableSelectionController<Row>(
      options as SelectionControllerOptions<Row>,
    );
  }
  return new TableSelectionStore<Row>(
    options as SelectionStoreOptions<Row> | string,
  );
}

export const createSelectionController = createTableSelectionController;
export const createRunner = createTableSelectionController;
export const createRpaSelection = createTableSelectionController;
export const selectTableRows = runTableSelection;
export const selectRows = runTableSelection;
export const applyTableSelection = runTableSelection;
