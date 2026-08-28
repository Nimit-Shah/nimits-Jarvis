"use client";

import { useState, useEffect } from "react";
import { THINKING_WORDS } from "./thinking-words";
import { TextShimmer } from "~/components/ui/text-shimmer";

export function ThinkingIndicator() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setIndex((i) => (i + 1) % THINKING_WORDS.length);
    }, 2500);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="py-2">
      <TextShimmer
        as="span"
        duration={1}
        className="text-[12px] font-medium"
      >
        {`${THINKING_WORDS[index]}...`}
      </TextShimmer>
    </div>
  );
}
