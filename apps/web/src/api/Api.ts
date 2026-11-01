import { Context, Effect, flow, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { Comment, DesignSummary, Snapshot } from "@/design/schema";

/** Who is commenting. Users have no accounts yet; see `@/lib/user`. */
export interface CommentAuthor {
  readonly id: string;
  readonly name: string;
}

export interface NewComment {
  readonly author: CommentAuthor;
  readonly body: string;
  /** The artboard the pin sits on. `x` and `y` are relative to it, or to the canvas when `null`. */
  readonly artboardId: string | null;
  readonly nodeId: string | null;
  readonly x: number;
  readonly y: number;
}

/** What an edit made: its change's `seq`, or `null` when nothing changed. */
const Changed = Schema.Struct({ seq: Schema.NullOr(Schema.Number) });

export class Health extends Schema.Class<Health>("Health")({
  status: Schema.Literal("ok"),
  version: Schema.String,
}) {}

export class ApiError extends Schema.TaggedError<ApiError>()("ApiError", {
  cause: Schema.Defect(),
}) {}

/**
 * The server understood a request and refused it, with a reason a person can
 * read, like "this design has 500 open comments, the most it can have;
 * resolve some first". It answers such requests with `422` and the reason
 * as plain text.
 */
export class Refused extends Schema.TaggedError<Refused>()("Refused", {
  reason: Schema.String,
}) {}

/**
 * Typed client for the Rust server. Every route lives under `/api` on the
 * page's origin. Live updates come over WebSockets (see `@/design/socket`).
 */
export class Api extends Context.Service<
  Api,
  {
    readonly health: Effect.Effect<Health, ApiError>;
    /** Designs whose name contains `query`, most recently edited first. */
    searchDesigns(query: string): Effect.Effect<ReadonlyArray<DesignSummary>, ApiError>;
    createDesign(name: string): Effect.Effect<DesignSummary, ApiError>;
    getDesign(id: string): Effect.Effect<Snapshot, ApiError>;
    createComment(
      designId: string,
      comment: NewComment,
    ): Effect.Effect<Comment, ApiError | Refused>;
    replyToComment(
      designId: string,
      commentId: string,
      reply: { readonly author: CommentAuthor; readonly body: string },
    ): Effect.Effect<Comment, ApiError | Refused>;
    setCommentResolved(
      designId: string,
      commentId: string,
      resolved: boolean,
    ): Effect.Effect<Comment, ApiError | Refused>;
    /** Replaces the CSS every artboard shares, as an edit by `author`. Blank CSS removes it. */
    setSharedCss(
      designId: string,
      author: CommentAuthor,
      css: string,
    ): Effect.Effect<void, ApiError | Refused>;
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

      const toApiError = Effect.mapError((cause: unknown) => new ApiError({ cause }));

      const health = client
        .get("/health")
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(Health)),
          toApiError,
          Effect.withSpan("Api.health"),
        );

      const searchDesigns = (query: string) =>
        client
          .get(`/designs?q=${encodeURIComponent(query)}`)
          .pipe(
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Array(DesignSummary))),
            toApiError,
            Effect.withSpan("Api.searchDesigns"),
          );

      const createDesign = Effect.fn("Api.createDesign")(function* (name: string) {
        const request = HttpClientRequest.post("/designs").pipe(
          HttpClientRequest.bodyJsonUnsafe({ name }),
        );
        return yield* client
          .execute(request)
          .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(DesignSummary)), toApiError);
      });

      const getDesign = Effect.fn("Api.getDesign")(function* (id: string) {
        return yield* client
          .get(`/designs/${encodeURIComponent(id)}`)
          .pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Snapshot)), toApiError);
      });

      // A `422` says why the server refused, so that reaches the person as `Refused`.
      const send = <A>(
        request: HttpClientRequest.HttpClientRequest,
        body: unknown,
        schema: Schema.Codec<A, unknown>,
      ) =>
        client.execute(request.pipe(HttpClientRequest.bodyJsonUnsafe(body))).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
          Effect.catchTag("HttpClientError", (error) =>
            error.reason._tag === "StatusCodeError" && error.reason.response.status === 422
              ? error.reason.response.text.pipe(
                  Effect.flatMap((reason) => Effect.fail(new Refused({ reason }))),
                )
              : Effect.fail(error),
          ),
          Effect.mapError((error) =>
            error instanceof Refused ? error : new ApiError({ cause: error }),
          ),
        );

      const sendComment = (request: HttpClientRequest.HttpClientRequest, body: unknown) =>
        send(request, body, Comment);

      const comments = (designId: string) => `/designs/${encodeURIComponent(designId)}/comments`;

      const createComment = Effect.fn("Api.createComment")(function* (
        designId: string,
        comment: NewComment,
      ) {
        return yield* sendComment(HttpClientRequest.post(comments(designId)), comment);
      });

      const replyToComment = Effect.fn("Api.replyToComment")(function* (
        designId: string,
        commentId: string,
        reply: { readonly author: CommentAuthor; readonly body: string },
      ) {
        const path = `${comments(designId)}/${encodeURIComponent(commentId)}/replies`;
        return yield* sendComment(HttpClientRequest.post(path), reply);
      });

      const setCommentResolved = Effect.fn("Api.setCommentResolved")(function* (
        designId: string,
        commentId: string,
        resolved: boolean,
      ) {
        const path = `${comments(designId)}/${encodeURIComponent(commentId)}`;
        return yield* sendComment(HttpClientRequest.patch(path), { resolved });
      });

      const setSharedCss = Effect.fn("Api.setSharedCss")(function* (
        designId: string,
        author: CommentAuthor,
        css: string,
      ) {
        const path = `/designs/${encodeURIComponent(designId)}/css`;
        yield* send(HttpClientRequest.put(path), { author, css }, Changed);
      });

      return Api.of({
        health,
        searchDesigns,
        createDesign,
        getDesign,
        createComment,
        replyToComment,
        setCommentResolved,
        setSharedCss,
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
