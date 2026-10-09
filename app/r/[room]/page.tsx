import type { Metadata } from "next";
import Room from "@/components/Room";

type Props = { params: Promise<{ room: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { room } = await params;
  return { title: `${room} | Chaos Whiteboard` };
}

export default async function Page({ params }: Props) {
  const { room } = await params;
  return <Room roomId={room.toLowerCase()} />;
}
