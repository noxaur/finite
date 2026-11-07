declare module "postcss-less" {
  import type { Parser, Stringifier } from "postcss";
  export const parse: Parser;
  export const stringify: Stringifier;
}
