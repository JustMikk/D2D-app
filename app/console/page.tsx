import { redirect } from "next/navigation";

// The live map is the console home (PRD §6.3).
export default function ConsoleHome() {
  redirect("/console/map");
}
