// The plugin's window. It picks files and downloads them; the main thread
// does the rest and answers with a line to show.

import { fileName } from "./file-name.ts";
import type { ToMain, ToUi } from "./messages.ts";

const save = document.querySelector<HTMLButtonElement>("#save")!;
const open = document.querySelector<HTMLButtonElement>("#open")!;
const file = document.querySelector<HTMLInputElement>("#file")!;
const result = document.querySelector<HTMLParagraphElement>("#result")!;

const post = (message: ToMain) => parent.postMessage({ pluginMessage: message }, "*");
const show = (line: string, failed = false) => {
  result.textContent = line;
  result.dataset.failed = String(failed);
};

function download(name: string, json: string) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  link.download = fileName(name);
  link.click();
  URL.revokeObjectURL(link.href);
}

save.addEventListener("click", () => {
  show("Reading the selection…");
  post({ type: "save" });
});
open.addEventListener("click", () => file.click());
file.addEventListener("change", async () => {
  const picked = file.files?.[0];
  // Clear it, so picking the same file again still counts as a change.
  file.value = "";
  if (!picked) return;
  show("Building…");
  post({ type: "open", text: await picked.text() });
});

window.addEventListener("message", (event: MessageEvent<{ pluginMessage?: ToUi }>) => {
  const message = event.data.pluginMessage;
  if (!message) return;
  switch (message.type) {
    case "selection":
      save.disabled = message.count === 0;
      break;
    case "saved":
      download(message.name, message.json);
      show(message.line);
      break;
    case "built":
      show(message.line);
      break;
    case "failed":
      show(message.line, true);
      break;
  }
});
