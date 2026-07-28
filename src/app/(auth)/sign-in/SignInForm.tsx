"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { acceptPendingInviteAction } from "../join/[code]/actions";

// Extract invite code from a /join/<code> path.
const INVITE_PATH_RE = /^\/join\/([0-9a-f]{32})$/i;

export default function SignInForm({ redirectTo }: { redirectTo?: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const supabase = createClient();
    const { data: { user }, error: authError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (authError) {
      setError(authError.message);
      setLoading(false);
      return;
    }

    if (!user) {
      setError("Sign-in failed. Please try again.");
      setLoading(false);
      return;
    }

    // After authentication, try to accept a pending invite.
    // Extract an explicit code from the redirect param if it is an invite path;
    // acceptPendingInviteAction will fall back to the ct_invite_pending cookie
    // if no explicit code is provided or the redirect param is something else.
    const inviteMatch = redirectTo?.match(INVITE_PATH_RE);
    const result = await acceptPendingInviteAction(inviteMatch?.[1]);

    // If acceptPendingInviteAction called redirect(), the component unmounts and
    // none of the code below executes. We only reach here when:
    //   { noInvite: true }  — no invite to accept; fall through to normal navigation
    //   { error: string }   — acceptance failed; show error

    if (result && "error" in result) {
      setError(result.error);
      setLoading(false);
      return;
    }

    // No invite was accepted — navigate based on profile completeness.
    const { data: profile } = await supabase
      .from("profiles")
      .select("first_name, last_name")
      .eq("id", user.id)
      .single();

    const firstName = profile?.first_name?.trim() ?? "";
    const lastName  = profile?.last_name?.trim()  ?? "";
    // Hard navigation, not router.push: an identity change must be a hard
    // application boundary. A soft navigation from /sign-in into the (app)
    // shell can serve the Header/SideNav/BottomNav from Next's client
    // router cache, showing the PREVIOUS account's club/role until a
    // manual refresh (the (app) layout re-renders correctly server-side,
    // but a cached client render can still be reused for a beat). A full
    // document load forces every authenticated surface to be fetched fresh
    // under the new session.
    if (!firstName || !lastName) {
      window.location.replace("/welcome");
    } else {
      window.location.replace("/calendar");
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-gray-100 mb-8">Sign in</h1>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="email"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="ct-input"
          />
        </div>

        <div>
          <label
            htmlFor="password"
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="ct-input"
          />
        </div>

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        )}

        <button
          type="submit"
          disabled={loading}
          className="ct-button-primary w-full"
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <div className="mt-4 text-center">
        <Link
          href="/forgot-password"
          className="text-sm text-gray-500 dark:text-gray-400 underline"
        >
          Forgot password?
        </Link>
      </div>
    </div>
  );
}
