import type { Actor } from "@finite/protocol";
import { useState } from "react";
import { localUser } from "@/client/finite";

export { localUser };

const NAME_KEY = "finite.user.name";
const NAME_LIMIT = 60;

/** The name this browser goes by, and a setter that saves it. */
export function useLocalName(): [string, (name: string) => void] {
  const [name, setName] = useState(() => localUser().name);
  const save = (next: string) => {
    const trimmed = next.trim().slice(0, NAME_LIMIT);
    try {
      if (trimmed) localStorage.setItem(NAME_KEY, trimmed);
      else localStorage.removeItem(NAME_KEY);
    } catch {
      // Blocked storage: the name lasts for this page.
    }
    setName(trimmed || "Guest");
  };
  return [name, save];
}

/** Whether `actor` is the person using this browser. */
export const isLocalUser = (actor: Actor) => actor.kind === "person" && actor.id === localUser().id;
