import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { type OpenDesign, Refused } from "@finite/protocol";
import { freeName, inRoot, type Locked, posixRelative } from "./files.ts";

const IMAGE = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg"]);
const VIDEO = new Set([".mp4", ".webm", ".mov"]);
const ATTACHMENTS = ".finite/attachments/";

/**
 * Copies an attachment into the design's brand folder, under the name it was attached with, and
 * returns where. The brand folder lies inside the fence and shows on the Brand page, so a prototype
 * never writes production.
 */
export async function addAsset(
  open: OpenDesign,
  attachment: string,
  locked: Locked,
): Promise<{ asset: string }> {
  const { root, brandDir, router } = open.design;
  const from = path.posix.normalize(attachment);
  if (!from.startsWith(ATTACHMENTS))
    throw new Refused(`${attachment} isn't an attachment of this design`, "invalid");
  const name = path.posix.basename(from).replace(/^[0-9a-f]{8}-/, "");
  const ext = path.posix.extname(name).toLowerCase();
  if (!IMAGE.has(ext) && !VIDEO.has(ext))
    throw new Refused(
      `${name} isn't an image or video Finite can place. Use one of ${[...IMAGE, ...VIDEO].join(", ")}.`,
      "invalid",
    );
  if (VIDEO.has(ext) && (router === "next-app" || router === "next-pages"))
    throw new Refused(
      `A Next.js project can't import ${ext} files, so this video can't go in as an import. Put it in public/ and ask the agent to add it.`,
      "not-implemented",
    );
  const dir = inRoot(root, brandDir);
  const source = inRoot(root, from);
  return locked([`${dir}${path.sep}`], async () => {
    await mkdir(dir, { recursive: true });
    const target = await freeName(path.join(dir, name));
    try {
      await copyFile(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Refused(`${attachment} doesn't exist`, "not-found");
      throw error;
    }
    return { asset: posixRelative(root, target) };
  });
}
