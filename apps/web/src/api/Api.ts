import { Context, Effect, flow, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export class Health extends Schema.Class<Health>("Health")({
  status: Schema.Literal("ok"),
  version: Schema.String,
}) {}

export class Greeting extends Schema.Class<Greeting>("Greeting")({
  message: Schema.String,
}) {}

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  cause: Schema.Defect(),
}) {}

/** Typed client for the Rust server. Every route lives under `/api` on the page's origin. */
export class Api extends Context.Service<
  Api,
  {
    readonly health: Effect.Effect<Health, ApiError>;
    greet(name: string): Effect.Effect<Greeting, ApiError>;
  }
>()("finite/Api") {
  static readonly layer = Layer.effect(
    Api,
    Effect.gen(function* () {
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(
          flow(
            HttpClientRequest.prependUrl(`${window.location.origin}/api`),
            HttpClientRequest.acceptJson,
          ),
        ),
        HttpClient.filterStatusOk,
      );

      const health = client.get("/health").pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)),
        Effect.mapError((cause) => new ApiError({ cause })),
        Effect.withSpan("Api.health"),
      );

      const greet = Effect.fn("Api.greet")(function* (name: string) {
        return yield* client.get("/greet", { urlParams: { name } }).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Greeting)),
          Effect.mapError((cause) => new ApiError({ cause })),
        );
      });

      return Api.of({ health, greet });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
