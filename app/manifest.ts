import type { MetadataRoute } from "next";
import { BRAND } from "@/lib/ui/brand";

// The installable rep app (PRD REP-1). It opens straight on Today.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Canvass",
    short_name: "Canvass",
    description: "Your day of door visits",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: BRAND.background,
    theme_color: BRAND.theme,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
