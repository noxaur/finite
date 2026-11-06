"use client";

// TEMPORARY (S5): a bare page that mounts the new canvas for a headless check. Delete once
// DesignScreen uses `@/canvas` instead of `canvasStub`.

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useDesignState } from "@/client/finite";
import { Canvas, Inspector, LayersTree, TokensSection } from "@/canvas";

function Dev() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const view = useDesignState(id);
  const [open, setOpen] = useState(true);
  const canvas =
    view.state?.canvases.find((c) => c.id === params.get("canvas")) ?? view.state?.canvases[0];
  if (!view.state) return <p>{view.error ?? "Loading…"}</p>;
  return (
    <div style={{ display: "flex", height: "100vh" }}>
      <div style={{ width: 246, overflow: "auto" }}>
        <LayersTree canvas={canvas} />
        <TokensSection designId={id} />
      </div>
      <div style={{ flex: 1, position: "relative" }}>
        <Canvas designId={id} canvas={canvas} mode="design" />
      </div>
      <Inspector open={open} onOpenChange={setOpen} />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <Dev />
    </Suspense>
  );
}
