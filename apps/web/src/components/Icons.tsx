import { type ReactElement, useId } from "react";
import { type IconName, iconMarkup } from "@/lib/icons";

/** A hand-drawn icon that follows the surrounding text color. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }): ReactElement {
  const key = useId();
  // The markup is built from constants, a number and React's id, never from user input.
  return (
    <span
      style={{ display: "contents" }}
      dangerouslySetInnerHTML={{ __html: iconMarkup(name, size, key) }}
    />
  );
}
