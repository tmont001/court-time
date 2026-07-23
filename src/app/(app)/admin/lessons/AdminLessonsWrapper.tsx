"use client";

import { useState } from "react";
import LessonsTab from "@/app/(app)/events/LessonsTab";
import AdminRequestLessonSheet from "./AdminRequestLessonSheet";
import type { ProLessonRequestRow, ClubPro } from "@/app/(app)/lessons/actions";

interface Member {
  id:         string;
  first_name: string | null;
  last_name:  string | null;
  email:      string | null;
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
  clubTimezone: string;
  pros:         ClubPro[];
  members:      Member[];
  lessonTypes:  LessonType[];
}

export default function AdminLessonsWrapper({
  requests,
  courts,
  userId,
  clubTimezone,
  pros,
  members,
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
        clubTimezone={clubTimezone}
        pros={pros}
        onCreateRequest={() => setCreateSheetOpen(true)}
      />

      {createSheetOpen && (
        <AdminRequestLessonSheet
          pros={pros}
          members={members}
          courts={courts}
          lessonTypes={lessonTypes}
          onClose={() => setCreateSheetOpen(false)}
        />
      )}
    </>
  );
}
