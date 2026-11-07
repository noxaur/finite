import type { ReactNode } from "react";

export default function Wrapper({ children }: { children: ReactNode }) {
  return <div data-wrapper="">{children}</div>;
}
