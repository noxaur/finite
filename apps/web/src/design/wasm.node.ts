// Loads finite.wasm in tests. They run in Node, where no bundler serves the
// file, so this reads it from disk. `wasm.setup.ts` builds it first.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initDesignModel } from "./wasm";

initDesignModel(
  readFileSync(resolve(import.meta.dirname, "../../../../crates/wasm/dist/finite.wasm")),
);
