import { Layer, ManagedRuntime } from "effect";
import { Api } from "@/api/Api";

/** One runtime for the whole app. Add service layers here as the app grows. */
export const AppLayer = Layer.mergeAll(Api.layer);

export const runtime = ManagedRuntime.make(AppLayer);
