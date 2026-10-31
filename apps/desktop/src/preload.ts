import { contextBridge } from "electron";

// Keep this surface small and typed; mirror changes in apps/web/src/global.d.ts.
contextBridge.exposeInMainWorld("finite", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },
});
