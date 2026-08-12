"use client";

import { useState } from "react";
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
  requests:     ProLessonRequestRow[];
  courts:       Court[];
  userId:       string;
  clubId:       string;
  clubTimezone: string;
  pros:         ClubPro[];
  rosterMembers: RosterMemberOption[];
  lessonTypes:  LessonType[];
}

export default function AdminLessonsWrapper({
  requests,
  courts,
  userId,
  clubId,
  clubTimezone,
  pros,
  rosterMembers,
  lessonTypes,
}: Props) {
  const [createSheetOpen, setCreateSheetOpen] = useState(false);

  return (
    <>
      <LessonsTab
        initialRequests={requests}
        courts={courts}
        userId={userId}
        userRole="admin"
        clubId={clubId}
        clubTimezone={clubTimezone}
        pros={pros}
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
          onClose={() => setCreateSheetOpen(false)}
        />
      )}
    </>
  );
}
