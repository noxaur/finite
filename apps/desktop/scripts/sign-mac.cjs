// electron-builder's afterPack hook: signs the Mac app with the certificate
// in MAC_CERTIFICATE (a base64 .p12) and MAC_CERTIFICATE_PASSWORD.
//
// Squirrel.Mac, which installs updates, only accepts an update signed with
// the same certificate as the running app. Any certificate works, so the
// release workflow uses a self-signed one. electron-builder only signs with
// certificates macOS trusts, so electron-builder.yml turns its signing off
// (`identity: null`) and this hook signs instead. It runs before the zip and
// the disk image are made.
//
// The certificate goes into a temporary keychain, which the hook deletes
// when it's done, so it never touches your login keychain.
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { signApp } = require("@electron/osx-sign");

const security = (...args) => execFileSync("/usr/bin/security", args, { encoding: "utf8" });

exports.default = async function signMac(context) {
  if (context.electronPlatformName !== "darwin") return;
  const certificate = process.env.MAC_CERTIFICATE;
  if (!certificate) {
    console.log(
      "  • MAC_CERTIFICATE isn't set, so the Mac app is unsigned and can't update itself",
    );
    return;
  }
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finite-signing-"));
  const keychain = path.join(dir, "signing.keychain-db");
  const keychainPassword = crypto.randomBytes(24).toString("hex");
  const searchList = security("list-keychains", "-d", "user")
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  try {
    security("create-keychain", "-p", keychainPassword, keychain);
    security("set-keychain-settings", keychain);
    security("unlock-keychain", "-p", keychainPassword, keychain);
    const p12 = path.join(dir, "certificate.p12");
    fs.writeFileSync(p12, Buffer.from(certificate, "base64"));
    security(
      "import",
      p12,
      "-k",
      keychain,
      "-P",
      process.env.MAC_CERTIFICATE_PASSWORD ?? "",
      "-T",
      "/usr/bin/codesign",
    );
    // Lets codesign use the key without a permission dialog.
    security(
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      keychainPassword,
      keychain,
    );
    security("list-keychains", "-d", "user", "-s", keychain, ...searchList);
    // The certificate isn't trusted, so `find-identity` without `-v`.
    const identity = /\b([0-9A-F]{40})\b/.exec(
      security("find-identity", "-p", "codesigning", keychain),
    )?.[1];
    if (!identity) throw new Error("MAC_CERTIFICATE holds no code signing identity");
    await signApp({
      app,
      identity,
      keychain,
      platform: "darwin",
      identityValidation: false,
      // The hardened runtime is only needed to notarize, which takes an
      // Apple Developer ID, and it would refuse to load Electron's
      // frameworks signed by a certificate without a team. Apple's timestamp
      // server may refuse a certificate it didn't issue, and a timestamp only
      // matters once the certificate expires, in 2056.
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
    });
    console.log(`  • signed ${path.basename(app)} with ${identity}`);
  } finally {
    security("list-keychains", "-d", "user", "-s", ...searchList);
    try {
      security("delete-keychain", keychain);
    } catch {
      // Already gone.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
};
