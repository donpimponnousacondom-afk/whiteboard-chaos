import type { Metadata } from "next";
import Admin from "@/components/Admin";

export const metadata: Metadata = { title: "God mode | Chaos Whiteboard", robots: { index: false } };

export default function Page() {
  return <Admin />;
}
