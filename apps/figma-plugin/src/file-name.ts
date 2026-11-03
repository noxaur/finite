/** The name of the file a saved selection downloads as, without characters a file name can't have. */
export function fileName(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]+/g, "-").trim() || "selection"}.figma.json`;
}
