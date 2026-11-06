"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { DesignCanvas } from "@/components/DesignCanvas";

// The static export can't prerender a route per design, so the id is a query
// parameter: `/design/?id=…`. Switching tabs changes only the parameter, so
// the key starts each design's canvas fresh, with none of the last one's state.
function DesignRoute() {
  const id = useSearchParams().get("id");
  return id ? <DesignCanvas key={id} id={id} /> : <p>Missing design id.</p>;
}

export default function Page() {
  return (
    <Suspense>
      <DesignRoute />
    </Suspense>
  );
}
