"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import LessonsTab from "@/app/(app)/events/LessonsTab";
import AdminRequestLessonSheet from "./AdminRequestLessonSheet";
import type { ProLessonRequestRow, ClubPro } from "@/app/(app)/lessons/actions";

// Phase 33D1: sourced from roster_members, not profiles — includes both
// claimed and no-account Members. Mirrors CalendarShell's RosterMemberOption.
interface RosterMemberOption {
  id:      string;
  name:    string;
  claimed: boolean;
}

interface Court {
  id:   string;
  name: string;
}

interface LessonType {
  id:                string;
  name:              string;
  allowed_durations: number[] | null;
}

interface Props {
  requests:      ProLessonRequestRow[];
  courts:        Court[];
  userId:        string;
  userName:      string;
  userRole:      "admin" | "pro";
  clubId:        string;
  clubTimezone:  string;
  pros:          ClubPro[];
  rosterMembers: RosterMemberOption[];
  lessonTypes:   LessonType[];
}

// Phase 33G2: shared by both the Admin and Pro branches of /admin/lessons —
// gives both roles a "Book Lesson" entry point (Admin: any Pro; Pro: self
// only — see AdminRequestLessonSheet's viewerRole handling), and honors
// Calendar → Lesson prefill via ?book=1&courtId=&startsAt=<ISO>, mirroring
// LessonsTab's own existing ?lessonId= auto-open pattern one file over.
// startsAt is passed as a single absolute instant (not a separate date +
// Calendar-relative slot index) because Calendar's own slot grid is indexed
// relative to that day's dynamic operating hours — an ISO timestamp is the
// only slot representation both this page and Calendar agree on.
export default function AdminLessonsWrapper({
  requests,
  courts,
  userId,
  userName,
  userRole,
  clubId,
  clubTimezone,
  pros,
  rosterMembers,
  lessonTypes,
}: Props) {
  const router       = useRouter();
  const pathname      = usePathname();
  const searchParams  = useSearchParams();
  const [createSheetOpen, setCreateSheetOpen] = useState(false);

  const bookParam       = searchParams.get("book");
  const prefillCourtId  = searchParams.get("courtId") ?? undefined;
  const prefillStartsAt = searchParams.get("startsAt") ?? undefined;

  // Fires once per distinct ?book=1 arrival (Calendar navigation), never
  // re-fights a user who has since closed the sheet on their own.
  const autoOpenAttemptRef = useRef<string | null>(null);

  useEffect(() => {
    if (!bookParam) return;
    const key = `${bookParam}:${prefillCourtId ?? ""}:${prefillStartsAt ?? ""}`;
    if (autoOpenAttemptRef.current === key) return;
    autoOpenAttemptRef.current = key;
    setCreateSheetOpen(true);
  }, [bookParam, prefillCourtId, prefillStartsAt]);

  // Strips the Calendar prefill params from the URL without adding a new
  // history entry, once the sheet they opened is closed — so reopening
  // "Book Lesson" manually afterward starts from today/first-court again,
  // not a stale Calendar selection.
  function clearBookParams() {
    autoOpenAttemptRef.current = null;
    const params = new URLSearchParams(searchParams.toString());
    if (!params.has("book")) return;
    params.delete("book");
    params.delete("courtId");
    params.delete("startsAt");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <>
      <LessonsTab
        initialRequests={requests}
        courts={courts}
        userId={userId}
        userRole={userRole}
        clubId={clubId}
        clubTimezone={clubTimezone}
        pros={userRole === "admin" ? pros : undefined}
        onCreateRequest={() => setCreateSheetOpen(true)}
      />

      {createSheetOpen && (
        <AdminRequestLessonSheet
          pros={pros}
          rosterMembers={rosterMembers}
          courts={courts}
          lessonTypes={lessonTypes}
          clubId={clubId}
          clubTimezone={clubTimezone}
          viewerRole={userRole}
          viewerId={userId}
          viewerName={userName}
          prefillCourtId={prefillCourtId}
          prefillStartsAt={prefillStartsAt}
          onClose={() => { setCreateSheetOpen(false); clearBookParams(); }}
        />
      )}
    </>
  );
}
