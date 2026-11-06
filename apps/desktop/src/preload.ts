import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

/** The menu commands main.ts sends; mirror changes in apps/web/src/global.d.ts. */
type FiniteCommand = "closeTab" | "nextTab" | "previousTab";

// Keep this surface small and typed; mirror changes in apps/web/src/global.d.ts.
contextBridge.exposeInMainWorld("finite", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
  onCommand(listener: (command: FiniteCommand) => void) {
    const handle = (_event: IpcRendererEvent, command: FiniteCommand) => listener(command);
    ipcRenderer.on("finite:command", handle);
    return () => void ipcRenderer.off("finite:command", handle);
  },
  /** Opens the system folder picker; resolves to the chosen path, or `null` when cancelled. */
  pickFolder(): Promise<string | null> {
    return ipcRenderer.invoke("finite:pickFolder") as Promise<string | null>;
  },
});
