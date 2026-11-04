import { Context, Effect, flow, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { type Audience, Comment, DesignSummary, Snapshot } from "@/design/schema";

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
  /** More elements in the same artboard, picked with shift-click. */
  readonly extraNodeIds: ReadonlyArray<string>;
  readonly x: number;
  readonly y: number;
  /** Who it's for. Any agent when left out. */
}

/** What an edit made: its change's `seq`, or `null` when nothing changed. */
const Changed = Schema.Struct({ seq: Schema.NullOr(Schema.Number) });

/** The formats an import reads, chosen by the file's extension. */
export type TransferFormat = "html" | "finite" | "figma" | "repo";

const Score = Schema.Literals(["yes", "no", "unknown"]);

/** One thing an import couldn't carry over exactly; see `docs/import-export.md`. */
export const ImportDiagnostic = Schema.Struct({
  /** The nearest node the import kept. */
  node: Schema.optionalKey(Schema.String),
  /** Where it was in the source. */
  path: Schema.String,
  /** What it was, like `onclick`. */
  what: Schema.String,
  feature: Schema.String,
  reason: Schema.String,
  preserved: Score,
  visual: Score,
  editable: Score,
  /** Kept out of the design because it could run code. It's still in the original file. */
  quarantined: Schema.optionalKey(Schema.Boolean),
});
export type ImportDiagnostic = typeof ImportDiagnostic.Type;

export const ImportRecord = Schema.Struct({
  id: Schema.String,
  /** Hash of the exact bytes received. */
  artifact: Schema.String,
  format: Schema.String,
  inputKind: Schema.String,
  fileName: Schema.optionalKey(Schema.String),
  receivedAt: Schema.Number,
  nodes: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  dependencies: Schema.optionalKey(
    Schema.Array(Schema.Struct({ url: Schema.String, blob: Schema.optionalKey(Schema.String) })),
  ),
  quarantined: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        node: Schema.optionalKey(Schema.String),
        path: Schema.String,
        what: Schema.String,
        reason: Schema.String,
      }),
    ),
  ),
});
export type ImportRecord = typeof ImportRecord.Type;

export const ImportResult = Schema.Struct({
  import: ImportRecord,
  /** The ids of the artboards the import made. */
  artboards: Schema.Array(Schema.String),
  diagnostics: Schema.Array(ImportDiagnostic),
});
export type ImportResult = typeof ImportResult.Type;

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
 * as plain text. An import also reports `404` and `500` that way.
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
    /** Changes who a comment is for, open or resolved. */
    setCommentAudience(
      designId: string,
      commentId: string,
      audience: Audience,
    ): Effect.Effect<Comment, ApiError | Refused>;
    /** Replaces the thread's newest message, which `author` must have written. */
    editLastMessage(
      designId: string,
      commentId: string,
      edit: { readonly author: CommentAuthor; readonly body: string },
    ): Effect.Effect<Comment, ApiError | Refused>;
    deleteComment(designId: string, commentId: string): Effect.Effect<void, ApiError>;
    /**
     * Sends a `.html` or `.finite` file's bytes to be imported as new artboards. They reach
     * every viewer over the socket; the result says what the import left out.
     */
    importFile(
      designId: string,
      file: { readonly name: string; readonly format: TransferFormat; readonly bytes: Uint8Array },
      /** The page the new artboards go on. */
      page?: string,
    ): Effect.Effect<ImportResult, ApiError | Refused>;
    /**
     * Names the modes in order (the first renames the first mode; extra names add modes),
     * then sets each token: one value for every mode, values by mode id or name, or
     * `null` to delete it. One edit by `author`.
     */
    setTokens(
      designId: string,
      author: CommentAuthor,
      change: {
        readonly modes?: ReadonlyArray<string>;
        readonly tokens?: Readonly<
          Record<string, string | Readonly<Record<string, string | null>> | null>
        >;
      },
    ): Effect.Effect<void, ApiError | Refused>;
    /** Deletes a mode and its token values; its artboards go back to the first mode. */
    deleteMode(
      designId: string,
      author: CommentAuthor,
      modeId: string,
    ): Effect.Effect<void, ApiError | Refused>;
    /** Sets the mode artboards render in, or the first mode for `null`. */
    setArtboardMode(
      designId: string,
      author: CommentAuthor,
      ids: ReadonlyArray<string>,
      modeId: string | null,
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
      const execute = <A>(
        request: HttpClientRequest.HttpClientRequest,
        schema: Schema.Codec<A, unknown>,
        explains: (status: number) => boolean = (status) => status === 422,
      ) =>
        client.execute(request).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
          Effect.catchTag("HttpClientError", (error) =>
            error.reason._tag === "StatusCodeError" && explains(error.reason.response.status)
              ? error.reason.response.text.pipe(
                  Effect.flatMap((reason) => Effect.fail(new Refused({ reason }))),
                )
              : Effect.fail(error),
          ),
          Effect.mapError((error) =>
            error instanceof Refused ? error : new ApiError({ cause: error }),
          ),
        );

      const send = <A>(
        request: HttpClientRequest.HttpClientRequest,
        body: unknown,
        schema: Schema.Codec<A, unknown>,
      ) => execute(request.pipe(HttpClientRequest.bodyJsonUnsafe(body)), schema);

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

      const setCommentAudience = Effect.fn("Api.setCommentAudience")(function* (
        designId: string,
        commentId: string,
        audience: Audience,
      ) {
        const path = `${comments(designId)}/${encodeURIComponent(commentId)}`;
        return yield* sendComment(HttpClientRequest.patch(path), { audience });
      });

      const editLastMessage = Effect.fn("Api.editLastMessage")(function* (
        designId: string,
        commentId: string,
        edit: { readonly author: CommentAuthor; readonly body: string },
      ) {
        const path = `${comments(designId)}/${encodeURIComponent(commentId)}/messages/last`;
        return yield* sendComment(HttpClientRequest.patch(path), edit);
      });

      const deleteComment = Effect.fn("Api.deleteComment")(function* (
        designId: string,
        commentId: string,
      ) {
        const path = `${comments(designId)}/${encodeURIComponent(commentId)}`;
        yield* client.del(path).pipe(toApiError);
      });

      const design = (designId: string) => `/designs/${encodeURIComponent(designId)}`;

      const setTokens = Effect.fn("Api.setTokens")(function* (
        designId: string,
        author: CommentAuthor,
        change: {
          readonly modes?: ReadonlyArray<string>;
          readonly tokens?: Readonly<
            Record<string, string | Readonly<Record<string, string | null>> | null>
          >;
        },
      ) {
        const path = `${design(designId)}/tokens`;
        yield* send(HttpClientRequest.put(path), { author, ...change }, Changed);
      });

      const deleteMode = Effect.fn("Api.deleteMode")(function* (
        designId: string,
        author: CommentAuthor,
        modeId: string,
      ) {
        const path = `${design(designId)}/modes/${encodeURIComponent(modeId)}`;
        yield* send(HttpClientRequest.delete(path), { author }, Changed);
      });

      const setArtboardMode = Effect.fn("Api.setArtboardMode")(function* (
        designId: string,
        author: CommentAuthor,
        ids: ReadonlyArray<string>,
        modeId: string | null,
      ) {
        const path = `${design(designId)}/artboards/mode`;
        yield* send(HttpClientRequest.put(path), { author, ids, mode: modeId }, Changed);
      });

      // The body is the file itself, so the file's name and format ride in the query.
      const importFile = Effect.fn("Api.importFile")(function* (
        designId: string,
        file: {
          readonly name: string;
          readonly format: TransferFormat;
          readonly bytes: Uint8Array;
        },
        page?: string,
      ) {
        const params = { format: file.format, name: file.name, ...(page ? { page } : {}) };
        const request = HttpClientRequest.post(
          `/designs/${encodeURIComponent(designId)}/import`,
        ).pipe(
          HttpClientRequest.setUrlParams(params),
          HttpClientRequest.bodyUint8Array(file.bytes, "application/octet-stream"),
        );
        // A `404` or `500` carries its message as text too, and the person should see it.
        return yield* execute(request, ImportResult, (status) => status >= 400);
      });

      return Api.of({
        health,
        searchDesigns,
        createDesign,
        getDesign,
        createComment,
        replyToComment,
        setCommentResolved,
        setCommentAudience,
        editLastMessage,
        deleteComment,
        importFile,
        setTokens,
        deleteMode,
        setArtboardMode,
      });
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));
}
