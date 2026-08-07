// Shared form-state shape for the pilot-inquiry form. Deliberately NOT a
// "use server" module — a Server Action file may only export async
// functions, so the runtime `initialPilotInquiryState` object (and these
// types, for symmetry) live here instead and are imported by both
// actions.ts and PilotInquiryForm.tsx.

export interface PilotInquiryFieldErrors {
  contactName?: string;
  email?: string;
  clubName?: string;
  facilityType?: string;
  facilityTypeOther?: string;
  courtCount?: string;
  memberCount?: string;
  website?: string;
  preferredOperatingModel?: string;
  currentProcess?: string;
  operationalChallenge?: string;
  additionalDetails?: string;
  phone?: string;
  preferredContactMethod?: string;
  form?: string;
}

export interface PilotInquiryFormValues {
  contactName: string;
  email: string;
  clubName: string;
  facilityType: string;
  facilityTypeOther: string;
  courtCount: string;
  memberCount: string;
  website: string;
  preferredOperatingModel: string;
  currentProcess: string;
  operationalChallenge: string;
  additionalDetails: string;
  phone: string;
  preferredContactMethod: string;
}

export type PilotInquiryState =
  | { status: "idle" }
  | { status: "error"; errors: PilotInquiryFieldErrors; values: PilotInquiryFormValues }
  | { status: "success"; inquiryId: string };

export const initialPilotInquiryState: PilotInquiryState = { status: "idle" };
