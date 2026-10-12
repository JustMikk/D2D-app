import { redirect } from "next/navigation";

// Settings now lives inside the rep app (so it works offline). Old links land on Today.
export default function RepSettingsRedirect() {
  redirect("/today");
}
