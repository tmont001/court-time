import { createClient } from "@/lib/supabase/server";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { getAuthUser, getAuthProfile } from "@/lib/supabase/user";
import { redirect } from "next/navigation";
import Header from "@/components/Header";
import MembersAreaTabs from "../MembersAreaTabs";
import MemberWaiverSection, {
  type CurrentWaiverDocument,
  type LegacyDraftVersion,
} from "../MemberWaiverSection";
import GuestWaiverSection, {
  type CurrentGuestWaiverDocument,
  type LegacyGuestDraftVersion,
} from "../GuestWaiverSection";

// Phase 43B-3E — relocated verbatim from the former "Memberships" group's
// Member Waiver / Guest Waiver subsections on /admin/settings into their
// own Admin Members hub tab. Same data reads, same components (moved,
// not rewritten), same Admin-only gate — pure IA relocation. Nothing
// about the proven 43B-3B PDF upload/finalize/view architecture changed
// (private Storage, signed upload/download, 10 MB limit, magic-header +
// SHA-256 validation, immutable version publication, Member/Guest
// independence, guarded orphan cleanup) — only which route renders these
// two components. Admin-only, matching the underlying RPCs' own gate
// (publish_waiver_pdf_version/discard_waiver_draft/set_*_waiver_required
// all reject non-Admin) — Staff's existing read-only compliance
// visibility elsewhere (Member Detail, /admin/members roster pills) is
// untouched by this move and does NOT gain waiver authoring here.

export default async function AdminMembersWaiversPage() {
  const user = await getAuthUser();
  if (!user) redirect("/sign-in");

  const profile = await getAuthProfile();
  if (profile?.role !== "admin") redirect("/calendar");

  const supabase = await createClient();
  const clubId = profile?.club_id ?? "";

  const { data: waiverRow } = await supabase
    .from("waivers")
    .select("id, is_required, current_version_id")
    .eq("club_id", clubId)
    .eq("audience", "member")
    .maybeSingle();

  const { data: guestWaiverRow } = await supabase
    .from("waivers")
    .select("id, is_required, current_version_id")
    .eq("club_id", clubId)
    .eq("audience", "guest")
    .maybeSingle();

  const [{ data: memberVersions }, { data: guestVersions }] = await Promise.all([
    waiverRow
      ? supabase
          .from("waiver_versions")
          .select("id, title, body, status, published_at")
          .eq("waiver_id", waiverRow.id)
      : Promise.resolve({ data: null }),
    guestWaiverRow
      ? supabase
          .from("waiver_versions")
          .select("id, title, body, status, published_at")
          .eq("waiver_id", guestWaiverRow.id)
      : Promise.resolve({ data: null }),
  ]);

  // waiver_document_files has ALL direct table access revoked (0196) —
  // its lookup goes through the privileged (service_role) client, never
  // the normal RLS-scoped one above. Narrow read keyed ONLY by version
  // ids this Server Component already resolved from the admin-RLS-scoped
  // waivers table a moment ago — never a client-supplied id.
  const currentVersionIds = [waiverRow?.current_version_id, guestWaiverRow?.current_version_id].filter(
    (id): id is string => Boolean(id)
  );
  let documentByVersionId = new Map<string, { originalFilename: string }>();
  if (currentVersionIds.length > 0) {
    const privileged = createPrivilegedClient();
    if (privileged) {
      const { data: docs } = await privileged
        .from("waiver_document_files")
        .select("waiver_version_id, original_filename")
        .in("waiver_version_id", currentVersionIds);
      documentByVersionId = new Map(
        (docs ?? []).map((d) => [d.waiver_version_id, { originalFilename: d.original_filename }])
      );
    }
  }

  // PDF-backed vs legacy text: a PDF-backed version always has body =
  // NULL (0196's publish_waiver_pdf_version always inserts body = null)
  // and a matching waiver_document_files row; a legacy text version has
  // a populated body and no document row.
  let currentMemberDocument: CurrentWaiverDocument | null = null;
  let legacyMemberDraft: LegacyDraftVersion | null = null;
  if (waiverRow) {
    const draft = memberVersions?.find((v) => v.status === "draft") ?? null;
    const current = memberVersions?.find((v) => v.id === waiverRow.current_version_id) ?? null;
    if (draft) {
      legacyMemberDraft = { id: draft.id, title: draft.title, body: draft.body ?? "" };
    }
    if (current) {
      const doc = documentByVersionId.get(current.id) ?? null;
      currentMemberDocument = {
        versionId: current.id,
        publishedAt: current.published_at ?? "",
        isPdfBacked: doc !== null,
        originalFilename: doc?.originalFilename ?? null,
        legacyTitle: doc ? null : current.title,
        legacyBody: doc ? null : current.body,
      };
    }
  }

  let currentGuestDocument: CurrentGuestWaiverDocument | null = null;
  let legacyGuestDraft: LegacyGuestDraftVersion | null = null;
  if (guestWaiverRow) {
    const guestDraft = guestVersions?.find((v) => v.status === "draft") ?? null;
    const guestCurrent = guestVersions?.find((v) => v.id === guestWaiverRow.current_version_id) ?? null;
    if (guestDraft) {
      legacyGuestDraft = { id: guestDraft.id, title: guestDraft.title, body: guestDraft.body ?? "" };
    }
    if (guestCurrent) {
      const doc = documentByVersionId.get(guestCurrent.id) ?? null;
      currentGuestDocument = {
        versionId: guestCurrent.id,
        publishedAt: guestCurrent.published_at ?? "",
        isPdfBacked: doc !== null,
        originalFilename: doc?.originalFilename ?? null,
        legacyTitle: doc ? null : guestCurrent.title,
        legacyBody: doc ? null : guestCurrent.body,
      };
    }
  }

  return (
    <>
      <Header screenTitle="Members" />
      {/* Phase 43B-3E2 browser-QA polish — width/centering (md:max-w-2xl
          md:mx-auto) now lives on this OUTER div, wrapping MembersAreaTabs
          alongside the padded content div below, so the tab strip aligns
          with the content it controls instead of stretching full-width on
          desktop. The inner div keeps its own px-4 (content padding) —
          MembersAreaTabs' own mx-4 margin lands on the same outer edge, so
          both stay visually aligned at every width. Purely a layout
          regrouping: no class changed, no width value added. */}
      <div className="md:max-w-2xl md:mx-auto">
        <MembersAreaTabs canManageMemberships={profile?.role === "admin"} />
        <div className="px-4 py-6 space-y-8 dark:text-gray-100">
          {/* Phase 43A-2 — Member Waiver. Deliberately independent of the
              Memberships enabled/disabled toggle (now on the Membership
              Types tab): waiver acceptance is a legal-agreement concept
              independent of the club-business "Membership" program. */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Member Waiver
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Upload your club&apos;s Member waiver as a PDF for Members to review and agree to.
              Replacing it requires Members to agree again.
            </p>
            <MemberWaiverSection
              waiverId={waiverRow?.id ?? null}
              isRequired={waiverRow?.is_required ?? true}
              currentDocument={currentMemberDocument}
              legacyDraft={legacyMemberDraft}
            />
          </div>

          <hr className="border-gray-100 dark:border-gray-800" />

          {/* Phase 43B-2B — Guest Waiver. An independently versioned
              document from the Member waiver above — separate waivers row
              (audience='guest'), separate Required toggle. No Guest
              acceptance flow exists yet — this section only manages the
              document. */}
          <div className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              Guest Waiver
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Upload a separate PDF waiver for Guests, independent from the Member waiver above.
            </p>
            <GuestWaiverSection
              waiverId={guestWaiverRow?.id ?? null}
              isRequired={guestWaiverRow?.is_required ?? true}
              currentDocument={currentGuestDocument}
              legacyDraft={legacyGuestDraft}
            />
          </div>
        </div>
      </div>
    </>
  );
}
