import { useState } from "react";
import type { Author } from "@/design/schema";
import type { CommentAuthor } from "@/api/Api";
import { NAME_LIMIT } from "./limits";

const ID_KEY = "finite.user";
const NAME_KEY = "finite.user.name";

/**
 * This browser's commenting identity. Users have no accounts yet, so each
 * browser keeps a random id in local storage, plus the name it comments
 * under ("Guest" until someone sets one).
 */
export function localUser(): CommentAuthor {
  let id = localStorage.getItem(ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(ID_KEY, id);
  }
  return { id, name: localStorage.getItem(NAME_KEY) || "Guest" };
}

/** The name this browser comments under, and a setter that saves it. */
export function useLocalName(): [string, (name: string) => void] {
  const [name, setName] = useState(() => localUser().name);
  const save = (next: string) => {
    const trimmed = next.trim().slice(0, NAME_LIMIT);
    if (trimmed) localStorage.setItem(NAME_KEY, trimmed);
    else localStorage.removeItem(NAME_KEY);
    setName(trimmed || "Guest");
  };
  return [name, save];
}

/** Whether `author` is this browser. The server prefixes user ids with `user:`. */
export const isLocalUser = (author: Author) =>
  author.kind === "user" && author.id === `user:${localUser().id}`;
