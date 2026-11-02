import { app, dialog, powerMonitor } from "electron";
import { autoUpdater } from "electron-updater";

/** How often a running app looks for a new release. */
export const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

/**
 * Keeps the packaged app up to date without asking. electron-updater reads
 * the feed the release workflow builds in (`-c.publish.url`) at launch,
 * every four hours and after the computer wakes. It downloads a new version
 * in the background and installs it the next time the app quits, so the
 * server is never stopped while agents are using it.
 */
export function keepUpToDate() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("error", (error) => console.error("Update failed:", error));
  autoUpdater.on("update-downloaded", ({ version }) =>
    console.log(`Finite ${version} is ready and installs when the app quits`),
  );
  // Errors also reach the "error" listener; the catch keeps them from
  // becoming unhandled rejections.
  const check = () => void autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, CHECK_INTERVAL_MS).unref();
  powerMonitor.on("resume", check);
}

/**
 * macOS can only update an app it can write to. Run from the disk image or
 * from Downloads, the app is read-only (Gatekeeper's App Translocation), so
 * offer to move it to /Applications. Moving relaunches the app from there.
 */
export async function offerMoveToApplications() {
  if (process.platform !== "darwin" || !app.isPackaged || app.isInApplicationsFolder()) return;
  const { response } = await dialog.showMessageBox({
    type: "question",
    message: "Move Finite to your Applications folder?",
    detail: "Finite keeps itself up to date, but only from the Applications folder.",
    buttons: ["Move to Applications", "Not Now"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return;
  try {
    app.moveToApplicationsFolder();
  } catch (error) {
    console.error("Couldn't move Finite to Applications:", error);
  }
}
