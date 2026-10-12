import Link from "next/link";
import { ApiError } from "@/lib/api/errors";
import { getInvite } from "@/lib/services/invites";
import { AcceptInviteForm } from "./AcceptInviteForm";

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invite = await getInvite(token).catch((error: unknown) => {
    if (error instanceof ApiError && error.code === "NOT_FOUND") return null;
    throw error;
  });

  if (!invite || !invite.valid) {
    return (
      <>
        <h1 className="text-title-l">This link has expired</h1>
        <p className="text-body-l text-ink-2">Invite links work once and last 7 days. Ask your manager to send a new one.</p>
        <Link href="/login" className="text-label text-link underline underline-offset-4">
          Go to sign in
        </Link>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-title-l">Set your password</h1>
        <p className="text-body-l text-ink-2">You&apos;re joining Canvass as {invite.email}.</p>
      </div>
      <AcceptInviteForm token={token} suggestedName={invite.suggestedName} />
    </>
  );
}
