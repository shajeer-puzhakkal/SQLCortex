"use client";

import * as React from "react";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      position="top-right"
      toastOptions={{
        classNames: {
          toast:
            "rounded-2xl border border-black/10 bg-white text-black shadow-lg shadow-black/10",
          title: "text-sm font-semibold",
          description: "text-sm text-black/60",
          actionButton:
            "rounded-full bg-black px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-white",
          cancelButton:
            "rounded-full border border-black/10 bg-white px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-black",
        },
      }}
      {...props}
    />
  );
}
