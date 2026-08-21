"use client";

import posthog from "posthog-js";
import { PostHogProvider as PHProvider } from "posthog-js/react";
import { useEffect } from "react";

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const environment =
      window.location.hostname === "localhost" ? "development" : "production";

    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      api_host: "/ingest",
      ui_host: "https://eu.posthog.com",
      capture_pageview: true,
      capture_pageleave: true,
      bootstrap: {
        distinctID: undefined,
      },
    });

    posthog.register({ environment });
    posthog.setPersonProperties({ environment });
  }, []);

  return <PHProvider client={posthog}>{children}</PHProvider>;
}
