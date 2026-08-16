import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Join apo",
  description: "Accept your invitation and create your own apo Project.",
}

export default function JoinLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <div className="min-h-screen bg-background">{children}</div>
}
