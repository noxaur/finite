import type { Plugin } from "vite";

export type FiniteOptions = {
  /** The design root, where `.finite/` lives. */
  root: string;
};

/** Stamps `data-finite-loc`/`data-finite-rev`, injects the bridge, serves frames and routes. */
export function finite(_options: FiniteOptions): Plugin[] {
  return [{ name: "finite" }];
}
