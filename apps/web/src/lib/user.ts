import type { Author } from "@/design/schema";
import type { CommentAuthor } from "@/api/Api";

const KEY = "finite.user";

/**
 * This browser's commenting identity. Users have no accounts yet, so each
 * browser keeps a random id in local storage and comments as "Guest".
 */
export function localUser(): CommentAuthor {
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
  }
  return { id, name: "Guest" };
}

/** Whether `author` is this browser. The server prefixes user ids with `user:`. */
export const isLocalUser = (author: Author) =>
  author.kind === "user" && author.id === `user:${localUser().id}`;
