"use client";

import * as stylex from "@stylexjs/stylex";
import type { Settings as SettingsValue } from "@finite/protocol";
import { useEffect, useRef } from "react";
import { finite, useClaudeStatus, useSettings } from "@/client/finite";
import { effortShort, findModel, modelName, pickableModels } from "@/lib/composer";
import { colors, fonts, radii, shadows, size, space } from "@/styles/tokens.stylex";
import { buttonStyle, Button, IconButton, Strip, StripItem } from "./Button";
import { Icon } from "./Icons";
import { Dropdown } from "./Menu";
import { Reason } from "./Reason";
import { toast } from "./Toast";

const set = (patch: Partial<SettingsValue>) =>
  finite
    .request("settings.set", { settings: patch })
    .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)));

/** Finite's few settings, in a modal: Claude's status, the defaults for new messages, the list. */
export function Settings({ onClose }: { onClose: () => void }) {
  const settings = useSettings();
  const claude = useClaudeStatus();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    void finite.refreshClaude();
  }, []);

  const models = claude?.models ?? [];
  const info = settings ? findModel(models, settings.model) : undefined;
  const levels = info?.supportedEffortLevels ?? (models.length ? [] : ["low", "medium", "high"]);

  return (
    <dialog
      ref={dialog}
      aria-label="Settings"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) dialog.current?.close();
      }}
      {...stylex.props(styles.dialog)}
    >
      <div {...stylex.props(styles.body)}>
        <header {...stylex.props(styles.head)}>
          <h2 {...stylex.props(styles.title)}>Settings</h2>
          <IconButton
            icon="close"
            label="Close settings"
            variant="ghost"
            size="small"
            onClick={() => dialog.current?.close()}
          />
        </header>

        <section {...stylex.props(styles.group)}>
          <h3 {...stylex.props(styles.label)}>Claude</h3>
          <div {...stylex.props(styles.status)}>
            <span
              {...stylex.props(
                styles.dot,
                claude?.installed && claude.loggedIn ? styles.dotOk : styles.dotOff,
              )}
            />
            {claude === null ? (
              <span {...stylex.props(styles.muted)}>Checking…</span>
            ) : !claude.installed || !claude.loggedIn ? (
              <span>
                {claude.installed
                  ? `Installed${claude.version ? ` (${claude.version})` : ""}, not logged in. `
                  : "Not installed. "}
                <Reason text={claude.reason ?? ""} code={styles.code} />
              </span>
            ) : (
              <span>
                Logged in{claude.email ? ` as ${claude.email}` : ""}
                {claude.version && (
                  <span {...stylex.props(styles.muted)}> · Claude Code {claude.version}</span>
                )}
              </span>
            )}
            <Button size="small" variant="ghost" onClick={() => void finite.refreshClaude()}>
              Check again
            </Button>
          </div>
        </section>

        {settings && (
          <>
            <section {...stylex.props(styles.group)}>
              <h3 {...stylex.props(styles.label)}>New messages</h3>
              <Row label="Model">
                <Dropdown
                  label="Default model"
                  value={settings.model}
                  options={pickableModels(models, settings.model).map(
                    (m) => [m.value, m.displayName] as const,
                  )}
                  onPick={(model) => void set({ model })}
                  style={[buttonStyle({}), styles.dropdown]}
                >
                  <span {...stylex.props(styles.dropdownText)}>
                    {modelName(models, settings.model)}
                  </span>
                  <Icon name="chevronDown" size={12} />
                </Dropdown>
              </Row>
              {levels.length > 0 && (
                <Row label="Reasoning">
                  <Strip role="radiogroup" aria-label="Reasoning" style={styles.strip}>
                    {levels.map((level) => (
                      <StripItem
                        key={level}
                        picked={settings.effort === level}
                        onClick={() => void set({ effort: level })}
                      >
                        {effortShort(level)}
                      </StripItem>
                    ))}
                  </Strip>
                </Row>
              )}
              {info?.supportsFastMode && (
                <Row label="Speed">
                  <Strip role="radiogroup" aria-label="Speed" style={styles.strip}>
                    <StripItem picked={!settings.fast} onClick={() => void set({ fast: false })}>
                      Standard
                    </StripItem>
                    <StripItem picked={settings.fast} onClick={() => void set({ fast: true })}>
                      Fast
                    </StripItem>
                  </Strip>
                </Row>
              )}
              <Row label="When I send while the agent works">
                <Strip role="radiogroup" aria-label="Send while working" style={styles.strip}>
                  <StripItem
                    picked={settings.sendMode === "steer"}
                    onClick={() => void set({ sendMode: "steer" })}
                  >
                    Steer
                  </StripItem>
                  <StripItem
                    picked={settings.sendMode === "queue"}
                    onClick={() => void set({ sendMode: "queue" })}
                  >
                    Queue
                  </StripItem>
                </Strip>
              </Row>
            </section>

            <section {...stylex.props(styles.group)}>
              <h3 {...stylex.props(styles.label)}>Prototypes list</h3>
              <label {...stylex.props(styles.toggleRow)}>
                <span>
                  Show Working separately
                  <span {...stylex.props(styles.hint)}>
                    Off: running threads stay in Active with a spinner.
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={settings.showWorkingSeparately}
                  onChange={(e) => void set({ showWorkingSeparately: e.target.checked })}
                  {...stylex.props(styles.switch)}
                />
              </label>
            </section>
          </>
        )}
      </div>
    </dialog>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div {...stylex.props(styles.row)}>
      <span {...stylex.props(styles.rowLabel)}>{label}</span>
      {children}
    </div>
  );
}

const styles = stylex.create({
  dialog: {
    width: 480,
    maxWidth: "calc(100vw - 36px)",
    padding: 0,
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: colors.border,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    boxShadow: shadows.raised,
    color: colors.text,
    fontFamily: fonts.sans,
    "::backdrop": { backgroundColor: "rgba(6, 7, 8, 0.45)" },
  },
  body: { display: "flex", flexDirection: "column", gap: space.lg, padding: space.lg },
  head: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  title: { margin: 0, fontSize: 15, fontWeight: 600 },
  group: { display: "flex", flexDirection: "column", gap: space.sm },
  label: { margin: 0, color: colors.muted, fontSize: 12, fontWeight: 500 },
  status: {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    fontSize: 13,
    lineHeight: "18px",
  },
  dot: { flexShrink: 0, width: 7, height: 7, borderRadius: "50%" },
  dotOk: { backgroundColor: colors.ok },
  dotOff: { backgroundColor: colors.faint },
  muted: { color: colors.muted },
  code: { fontFamily: fonts.mono, fontSize: 12 },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    minHeight: size.md,
    fontSize: 13,
  },
  rowLabel: { flexShrink: 1, minWidth: 0 },
  strip: { width: 210 },
  dropdown: { width: 210, justifyContent: "space-between" },
  dropdownText: { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" },
  toggleRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space.md,
    fontSize: 13,
    cursor: "var(--cursor-pointer, pointer)",
  },
  hint: { display: "block", marginTop: 2, color: colors.faint, fontSize: 12 },
  switch: {
    appearance: "none",
    flexShrink: 0,
    position: "relative",
    width: 30,
    height: 18,
    margin: 0,
    borderRadius: 9,
    backgroundColor: { default: colors.sunk, ":checked": colors.accent },
    boxShadow: shadows.field,
    cursor: "var(--cursor-pointer, pointer)",
    outline: { default: "none", ":focus-visible": `2px solid ${colors.brand}` },
    outlineOffset: 2,
    "::after": {
      content: '""',
      position: "absolute",
      top: 2,
      left: 2,
      width: 14,
      height: 14,
      borderRadius: "50%",
      backgroundColor: colors.halo,
      boxShadow: shadows.control,
      transition: "transform 150ms ease",
    },
    ":checked::after": { transform: "translateX(12px)" },
  },
});
