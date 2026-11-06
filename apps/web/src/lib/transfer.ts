import type { ImportDiagnostic, ImportResult, TransferFormat } from "@/api/Api";

/** What the Import picker accepts. */
export const IMPORT_ACCEPT = ".html,.htm,.finite,.figma.json,.tar";

/** How many left-out items the result lists before "and N more". */
export const LISTED = 5;

/** The format a file is read as, from its extension. `null` when Finite can't read it. */
export function formatOf(fileName: string): TransferFormat | null {
  // The Figma plugin saves `<name>.figma.json`; a plain `.json` file could be anything.
  if (fileName.toLowerCase().endsWith(".figma.json")) return "figma";
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = fileName.slice(dot + 1).toLowerCase();
  if (extension === "html" || extension === "htm") return "html";
  if (extension === "finite") return "finite";
  if (extension === "tar") return "repo";
  return null;
}

const designPath = (designId: string) => `/api/designs/${encodeURIComponent(designId)}`;

/** The link that downloads one artboard as HTML, or the whole design as `.finite`. */
export function exportHref(designId: string, artboardId: string | null): string {
  return artboardId === null
    ? `${designPath(designId)}/export?format=finite`
    : `${designPath(designId)}/export?format=html&artboard=${encodeURIComponent(artboardId)}`;
}

/** The link that downloads the whole design as a tar of text files, one HTML file per artboard, to keep in git. */
export function repoHref(designId: string): string {
  return `${designPath(designId)}/export?format=repo`;
}

/** The routers the app export can use. React Router is the default. */
export type AppRouter = "react-router" | "tanstack-router";

/** The link that downloads the whole design as a Vite + React project of its prototype flow, one route per `data-route`. */
export function appHref(designId: string, router: AppRouter = "react-router"): string {
  const chosen = router === "react-router" ? "" : `&router=${router}`;
  return `${designPath(designId)}/export?format=app${chosen}`;
}

/** The link that downloads one artboard as a `.figma.json` file for the Finite Figma plugin to open. */
export function figmaHref(designId: string, artboardId: string): string {
  return `${designPath(designId)}/export?format=figma&artboard=${encodeURIComponent(artboardId)}`;
}

/** The link that downloads one artboard as a React component (`.jsx`). */
export function jsxHref(designId: string, artboardId: string): string {
  return `${designPath(designId)}/export?format=jsx&artboard=${encodeURIComponent(artboardId)}`;
}

/** The Finite Figma plugin, zipped, from the latest release. The release workflow uploads it under this name. */
export const FIGMA_PLUGIN_URL =
  "https://github.com/noxaur/finite/releases/latest/download/finite-figma-plugin.zip";

/** The link that downloads the exact bytes an import received. */
export function originalHref(designId: string, importId: string): string {
  return `${designPath(designId)}/imports/${encodeURIComponent(importId)}/original`;
}

/** "Left out: onclick on Button — it could run code". `nameOf` gives a node's layer name. */
export function describe(
  diagnostic: ImportDiagnostic,
  nameOf: (nodeId: string) => string | undefined = () => undefined,
): string {
  const name = diagnostic.node === undefined ? undefined : nameOf(diagnostic.node);
  const where = name === undefined ? "" : ` on ${name}`;
  const label = diagnostic.quarantined ? "Left out" : "Note";
  return `${label}: ${diagnostic.what}${where} — ${diagnostic.reason}`;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** What to show after an import: a headline, the first few diagnostics, and how many more there are. */
export function summarize(
  result: ImportResult,
  nameOf?: (nodeId: string) => string | undefined,
): { headline: string; lines: ReadonlyArray<string>; more: number } {
  const count = result.artboards.length;
  return {
    headline: count === 0 ? "Imported no artboards." : `Imported ${plural(count, "artboard")}.`,
    lines: result.diagnostics.slice(0, LISTED).map((d) => describe(d, nameOf)),
    more: Math.max(0, result.diagnostics.length - LISTED),
  };
}
