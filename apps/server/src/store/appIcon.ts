import fs from "node:fs/promises";
import path from "node:path";
import { readText } from "./files.ts";

const EXTENSIONS = new Set([".svg", ".png", ".webp", ".jpg", ".jpeg", ".ico"]);
const MAX_BYTES = 1024 * 1024;

const NEXT_ICONS = [
  "icon.svg",
  "icon.png",
  "icon.webp",
  "icon.jpg",
  "icon.jpeg",
  "apple-icon.png",
  "apple-icon.jpg",
  "apple-icon.jpeg",
  "favicon.ico",
];

const PUBLIC_ICONS = [
  "favicon.svg",
  "icon.svg",
  "logo.svg",
  "apple-touch-icon.png",
  "icon.png",
  "logo.png",
  "favicon.png",
  "logo192.png",
  "favicon.ico",
];

/**
 * The absolute path of the connected app's own icon, or `undefined`. The first usable hit wins:
 * the icon `index.html` links (Vite), then Next's `app/` icon files, then common names in `public/`.
 * The repo is untrusted, so a candidate that leaves `root` (by `../` or a symlink), isn't a small
 * image file, or is the Vite template's placeholder is skipped.
 */
export async function findAppIcon(root: string): Promise<string | undefined> {
  const realRoot = await fs.realpath(root).catch(() => undefined);
  if (!realRoot) return undefined;
  const candidates = [
    ...(await htmlIcons(root)),
    ...["app", "src/app"].flatMap((dir) => NEXT_ICONS.map((name) => path.join(root, dir, name))),
    ...PUBLIC_ICONS.map((name) => path.join(root, "public", name)),
  ];
  for (const candidate of candidates) {
    const usable = await usableIcon(realRoot, candidate);
    if (usable) return usable;
  }
  return undefined;
}

/** The candidate's real path when it's a small image file inside the root, else `undefined`. */
async function usableIcon(realRoot: string, candidate: string): Promise<string | undefined> {
  if (!EXTENSIONS.has(path.extname(candidate).toLowerCase())) return undefined;
  if (path.basename(candidate) === "vite.svg") return undefined;
  const real = await fs.realpath(candidate).catch(() => undefined);
  if (!real || !real.startsWith(realRoot + path.sep)) return undefined;
  const stat = await fs.stat(real).catch(() => undefined);
  return stat?.isFile() && stat.size <= MAX_BYTES ? real : undefined;
}

/** The files `index.html` links as its icon, best first: an svg, then an apple-touch-icon, then the rest. */
async function htmlIcons(root: string): Promise<string[]> {
  const html = await readText(path.join(root, "index.html")).catch(() => undefined);
  if (!html) return [];
  const links: { href: string; rank: number }[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs.set(m[1]!.toLowerCase(), m[2] ?? m[3] ?? "");
    }
    const rel = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    const apple = rel.includes("apple-touch-icon");
    if (!apple && !rel.includes("icon")) continue;
    const href = cleanHref(attrs.get("href") ?? "");
    if (!href) continue;
    links.push({ href, rank: /\.svg$/i.test(href) ? 0 : apple ? 1 : 2 });
  }
  // `sort` is stable, so equal ranks keep their order in the file.
  return links
    .sort((a, b) => a.rank - b.rank)
    .flatMap(({ href }) =>
      // A root-relative href is served from `public/` first.
      href.startsWith("/")
        ? [path.join(root, "public", href), path.join(root, href)]
        : [path.join(root, href)],
    );
}

/**
 * The href without its query and hash, or `""` when it isn't a file in the repo. A leading
 * `%BASE_URL%` or `%PUBLIC_URL%` stands for the site root, so what follows is root-relative.
 */
function cleanHref(raw: string): string {
  const href = raw
    .trim()
    .replace(/^%(?:BASE_URL|PUBLIC_URL)%\/?/, "/")
    .replace(/[?#].*$/, "");
  return /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href) ? "" : href;
}
