import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/db/types";
import Link from "next/link";
import AcceptButton from "./AcceptButton";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
  member: "Member",
  pro:    "Pro",
  admin:  "Admin",
};

interface InviteValid {
  valid: true;
  club_name: string;
  role: string;
  email_restricted: boolean;
}

interface InviteInvalid {
  valid: false;
  reason: "not_found" | "expired" | "used" | "revoked";
}

type InviteResult = InviteValid | InviteInvalid;

const ERROR_CONTENT: Record<
  string,
  { heading: string; body: string }
> = {
  not_found: {
    heading: "Invite not found",
    body: "This invite link is not valid.",
  },
  expired: {
    heading: "Invite expired",
    body: "This invite has expired. Ask your admin for a new link.",
  },
  used: {
    heading: "Invite already used",
    body: "This invite has already been used.",
  },
  revoked: {
    heading: "Invite revoked",
    body: "This invite has been revoked. Ask your admin for a new link.",
  },
};

export default async function JoinPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  const supabase = await createClient();

  // validate_club_invite is security definer and safe for anon callers.
  const { data: rawInvite } = await supabase.rpc("validate_club_invite", {
    p_code: code,
  });
  const invite = rawInvite as InviteResult | null;

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // For signed-in users, check whether they already belong to a club.
  let profileClubId: string | null = null;
  let profileClubName: string | null = null;
  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("club_id")
      .eq("id", user.id)
      .single();
    profileClubId = profile?.club_id ?? null;
    if (profileClubId) {
      const { data: club } = await supabase
        .from("clubs")
        .select("name")
        .eq("id", profileClubId)
        .single();
      profileClubName = club?.name ?? null;
    }
  }

  // --- Invalid / error states ---
  if (!invite || !invite.valid) {
    const reason = !invite ? "not_found" : invite.reason;
    const { heading, body } = ERROR_CONTENT[reason] ?? ERROR_CONTENT.not_found;
    return (
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-3">
          {heading}
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">{body}</p>
      </div>
    );
  }

  const roleLabel = ROLE_LABELS[invite.role] ?? invite.role;

  // --- Signed in and already belongs to a club ---
  if (user && profileClubId) {
    return (
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-3">
          Already a member
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          You&apos;re already a member
          {profileClubName ? ` of ${profileClubName}` : ""}. Each account
          belongs to one club.
        </p>
      </div>
    );
  }

  // --- Signed out: show invite details and offer sign in or create account ---
  if (!user) {
    const signUpHref = `/sign-up?redirect=/join/${code}${invite.email_restricted ? "&emailRestricted=1" : ""}`;
    return (
      <div>
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-1">
          You&apos;re invited
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          You&apos;ve been invited to join{" "}
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {invite.club_name}
          </span>{" "}
          as a{" "}
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {roleLabel}
          </span>
          .
        </p>

        {invite.email_restricted && (
          <p className="mb-4 text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-md px-3 py-2">
            This invitation is restricted to a specific email address.
          </p>
        )}

        <div className="space-y-2">
          <Link
            href={`/sign-in?redirect=/join/${code}`}
            className="block w-full text-center bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 rounded-md px-3 py-2 text-sm font-medium"
          >
            Sign in to accept
          </Link>
          <Link
            href={signUpHref}
            className="block w-full text-center border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 rounded-md px-3 py-2 text-sm font-medium"
          >
            Create account
          </Link>
        </div>
      </div>
    );
  }

  // --- Signed in with no club yet: show accept button ---
  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-1">
        You&apos;re invited
      </h1>
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Join{" "}
        <span className="font-medium text-gray-900 dark:text-gray-100">
          {invite.club_name}
        </span>{" "}
        as a{" "}
        <span className="font-medium text-gray-900 dark:text-gray-100">
          {roleLabel}
        </span>
        .
      </p>
      <AcceptButton code={code} />
    </div>
  );
}
