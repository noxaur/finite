import type { ReactElement } from "react";
import { type IconName, iconMarkup } from "@/lib/icons";

/** An icon that follows the surrounding text color. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactElement {
  // The markup is built from constants and a number, never from user input.
  return (
    <span
      style={{ display: "contents" }}
      dangerouslySetInnerHTML={{ __html: iconMarkup(name, size) }}
    />
  );
}
