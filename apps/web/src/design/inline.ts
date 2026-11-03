/**
 * An SVG image has no network, so a bitmap can only show the pictures and
 * fonts the markup carries inside it. This fetches the remote ones an
 * artboard uses and puts them in as `data:` URLs. A resource it can't fetch
 * (CORS, an error, too big) rejects, and the artboard then stays live.
 */

/** The most bytes one resource may have... */
export const MAX_RESOURCE_BYTES = 4_000_000;
/** ...and all the resources of one artboard together. */
export const MAX_TOTAL_BYTES = 12_000_000;
/** How long one fetch may take. */
const TIMEOUT_MS = 10_000;
/** The most bytes of fetched resources kept for later bitmaps. */
const CACHE_BYTES = 48_000_000;

/** Fetches `url` as a `data:` URL, or rejects. `bytes` is its size before encoding. */
export type Fetcher = (url: string) => Promise<{ readonly data: string; readonly bytes: number }>;

const cache = new Map<string, { readonly data: string; readonly bytes: number }>();
let cached = 0;

/** The browser's fetch, with a size cap and a timeout. Resources are kept for the next artboard that uses them. */
export const fetchDataUrl: Fetcher = async (url) => {
  const hit = cache.get(url);
  if (hit) return hit;
  const response = await fetch(url, { mode: "cors", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  const blob = await response.blob();
  if (blob.size > MAX_RESOURCE_BYTES) throw new Error(`too big: ${url}`);
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  const entry = { data, bytes: blob.size };
  if (cached + entry.bytes <= CACHE_BYTES) {
    cache.set(url, entry);
    cached += entry.bytes;
  }
  return entry;
};

/** Forgets every kept resource. */
export function clearInlineCache() {
  cache.clear();
  cached = 0;
}

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g;
const CSS_IMPORT = /@import\s+(?:url\(\s*)?(?:"([^"]*)"|'([^']*)')\s*\)?[^;]*;/g;

/** Whether `ref` points at something the network has: not `data:`, a fragment, or `about:`. */
function isRemote(ref: string): boolean {
  return ref !== "" && !/^(data:|#|about:|blob:)/i.test(ref);
}

function absolute(ref: string, base: string): string | null {
  try {
    const url = new URL(ref, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Reads each resource through a shared total, so one artboard can't pull in more than the cap. */
class Budget {
  private used = 0;
  constructor(
    private readonly fetcher: Fetcher,
    private readonly base: string,
  ) {}

  /** The `data:` URL for `ref`, or `ref` itself if it isn't a network URL. */
  async data(ref: string, base = this.base): Promise<string> {
    if (!isRemote(ref)) return ref;
    const url = absolute(ref, base);
    if (url === null) return ref;
    const { data, bytes } = await this.fetcher(url);
    this.used += bytes;
    if (this.used > MAX_TOTAL_BYTES) throw new Error("too much to inline");
    return data;
  }

  /** The text of a stylesheet. */
  async text(url: string): Promise<string> {
    const { data } = await this.fetcher(url);
    const comma = data.indexOf(",");
    const body = data.slice(comma + 1);
    if (!/;base64$/i.test(data.slice(0, comma))) return decodeURIComponent(body);
    return new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
  }

  /**
   * `css` with its `url(...)` references inlined (fonts and pictures), and
   * its `@import`s replaced by the stylesheets they name. `base` is what
   * relative references resolve against.
   */
  async css(css: string, base = this.base, depth = 0): Promise<string> {
    let out = css;
    if (depth < 3) {
      for (const match of css.matchAll(CSS_IMPORT)) {
        const url = absolute(match[1] ?? match[2] ?? "", base);
        if (url === null) continue;
        out = out.replace(match[0], await this.css(await this.text(url), url, depth + 1));
      }
    }
    const refs = new Set<string>();
    for (const match of out.matchAll(CSS_URL)) {
      const ref = match[1] ?? match[2] ?? match[3] ?? "";
      if (isRemote(ref)) refs.add(ref);
    }
    for (const ref of refs) {
      const data = await this.data(ref, base);
      out = out.replaceAll(ref, data);
    }
    return out;
  }
}

/**
 * `html` and `css` with every remote picture, web font and linked stylesheet
 * they use put inside them. Rejects if one can't be fetched.
 */
export async function inlineRemote(
  html: string,
  css: string,
  fetcher: Fetcher = fetchDataUrl,
  base: string = document.baseURI,
): Promise<{ readonly html: string; readonly css: string }> {
  const budget = new Budget(fetcher, base);
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");

  for (const link of doc.body.querySelectorAll<HTMLLinkElement>("link[rel~=stylesheet][href]")) {
    const url = absolute(link.getAttribute("href") ?? "", base);
    if (url === null) continue;
    const style = doc.createElement("style");
    style.textContent = await budget.css(await budget.text(url), url);
    link.replaceWith(style);
  }
  for (const style of doc.body.querySelectorAll("style")) {
    style.textContent = await budget.css(style.textContent ?? "");
  }
  for (const el of doc.body.querySelectorAll("[style*='url(']")) {
    el.setAttribute("style", await budget.css(el.getAttribute("style") ?? ""));
  }
  await Promise.all(
    [...doc.body.querySelectorAll("img[src], image[href], image[xlink\\:href]")].map(
      async (img) => {
        const attribute = img.hasAttribute("src")
          ? "src"
          : img.hasAttribute("href")
            ? "href"
            : "xlink:href";
        img.setAttribute(attribute, await budget.data(img.getAttribute(attribute) ?? ""));
        // srcset would pick a candidate the image can't fetch.
        img.removeAttribute("srcset");
      },
    ),
  );
  return { html: doc.body.innerHTML, css: await budget.css(css) };
}
