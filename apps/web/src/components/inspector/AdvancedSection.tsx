"use client";

import { propName, summary, unclaimed } from "@/design/editing/advanced";
import { Row, RowBody, RowName, RowNote, Section, TokenChip, Toggle } from "./controls";
import type { Scope } from "./scope";

/**
 * The inline styles no control shows, like a mask or a clip path, by name
 * with a one-line summary, never as CSS. "−" takes one off. The section
 * isn't there when every inline style has a control.
 */
export function AdvancedSection({ scope }: { scope: Scope }) {
  const rows = new Map<string, string | null>();
  for (const t of scope.targets) {
    for (const [prop, value] of unclaimed(t.styles)) {
      const seen = rows.get(prop);
      rows.set(prop, seen === undefined || seen === value ? value : null);
    }
  }
  if (rows.size === 0) return null;
  return (
    <Section title="Advanced">
      {[...rows].map(([prop, value]) => {
        const line = value === null ? "Mixed" : summary(prop, value);
        return (
          <Row
            key={prop}
            action={
              <Toggle
                icon="minus"
                title={`Remove ${propName(prop).toLowerCase()}`}
                onClick={() =>
                  scope.commitEach((t) => (t.styles[prop] === undefined ? {} : { [prop]: null }))
                }
              />
            }
          >
            <RowBody title={propName(prop)}>
              <RowName>{propName(prop)}</RowName>
              {line.startsWith("--") ? <TokenChip name={line} /> : <RowNote>{line}</RowNote>}
            </RowBody>
          </Row>
        );
      })}
    </Section>
  );
}
