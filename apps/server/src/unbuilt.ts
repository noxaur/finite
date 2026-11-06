import { Refused } from "@finite/protocol";

/** What a module that isn't built yet does when it's called. Deleted once every module is built. */
export function unbuilt(what: string): Promise<never> {
  return Promise.reject(new Refused(`${what} isn't built yet`, "not-implemented"));
}
