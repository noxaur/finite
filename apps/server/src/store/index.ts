import type { Store } from "@finite/protocol";
import { unbuilt } from "../unbuilt.ts";

export type StoreOptions = {
  /** `$FINITE_DATA_DIR`: designs.json, settings.json, projects/. */
  dataDir: string;
};

export function createStore(_options: StoreOptions): Store {
  return {
    designs: () => unbuilt("store.designs"),
    create: () => unbuilt("store.create"),
    connect: () => unbuilt("store.connect"),
    remove: () => unbuilt("store.remove"),
    open: () => unbuilt("store.open"),
    settings: () => unbuilt("store.settings"),
    setSettings: () => unbuilt("store.setSettings"),
    on: () => () => {},
  };
}
