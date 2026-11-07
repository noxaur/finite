"use client";

import { useState } from "react";

export function Counter() {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      className="mt-4 rounded bg-brand px-3 py-1"
      onClick={() => setCount(count + 1)}
    >
      Clicked {count} times
    </button>
  );
}
