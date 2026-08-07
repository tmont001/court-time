"use server";

import { createHmac } from "node:crypto";
import { headers } from "next/headers";
import { createPrivilegedClient } from "@/lib/supabase/privileged";
import { sendEmail } from "@/lib/email";
import type {
  PilotInquiryFieldErrors,
  PilotInquiryFormValues,
  PilotInquiryState,
} from "./formState";

// ─── Controlled values ─────────────────────────────────────────────────────

const FACILITY_TYPES = [
  "private_club",
  "country_club",
  "hoa_residential",
  "public_municipal",
  "tennis_academy",
  "school_university",
  "other",
] as const;

// Exactly three — 'hybrid' was removed; 'not_sure' is the valid answer for
// an undecided visitor rather than an implicit fourth option.
const OPERATING_MODELS = ["staff_managed", "member_self_service", "not_sure"] as const;
const CONTACT_METHODS = ["email", "phone", "either"] as const;

const FACILITY_TYPE_LABELS: Record<string, string> = {
  private_club: "Private club",
  country_club: "Country club",
  hoa_residential: "HOA or residential community",
  public_municipal: "Public or municipal facility",
  tennis_academy: "Tennis academy",
  school_university: "School or university",
  other: "Other",
};

const OPERATING_MODEL_LABELS: Record<string, string> = {
  staff_managed: "Staff-managed",
  member_self_service: "Member self-service",
  not_sure: "Not sure yet",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/;

// Modest threshold for a low-volume pilot-inquiry form — kept in sync with
// the identical check in submit_pilot_inquiry() (migration 0105); the
// database is the authoritative enforcement point, this is just so the
// client-facing message below can name a sensible reason.
const FINGERPRINT_RATE_LIMIT_WINDOW_MINUTES = 10;

// ─── Helpers ────────────────────────────────────────────────────────────────

function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}

function toRequiredInt(raw: string): number | "invalid" {
  if (!/^\d+$/.test(raw)) return "invalid";
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : "invalid";
}

// One-way HMAC of the request's client-address header — never the raw
// address itself, which is read once here and discarded. Returns undefined
// (never throws, never falls back to a raw value) whenever the secret is
// unset or no usable address header is present, e.g. local dev — the RPC's
// duplicate-email-plus-club check still applies in that case, so a
// legitimate visitor is never blocked merely because fingerprinting isn't
// available.
async function computeRequestFingerprint(): Promise<string | undefined> {
  const secret = process.env.PILOT_INQUIRY_HASH_SECRET;
  if (!secret) return undefined;

  const h = await headers();
  const forwardedFor = h.get("x-forwarded-for");
  const firstForwarded = forwardedFor?.split(",")[0]?.trim();
  const raw = firstForwarded || h.get("x-real-ip")?.trim() || "";
  if (!raw) return undefined;

  return createHmac("sha256", secret).update(raw).digest("hex");
}

function buildOperatorEmail(params: {
  inquiryId: string;
  createdAt: string;
  values: PilotInquiryFormValues;
}): { subject: string; html: string; text: string } {
  const { inquiryId, createdAt, values } = params;
  const facilityLabel = FACILITY_TYPE_LABELS[values.facilityType] ?? values.facilityType;
  const modelLabel = OPERATING_MODEL_LABELS[values.preferredOperatingModel] ?? values.preferredOperatingModel;

  const rows: [string, string][] = [
    ["Inquiry ID", inquiryId],
    ["Submitted", createdAt],
    ["Contact name", values.contactName],
    ["Email", values.email],
    ["Phone", values.phone || "—"],
    ["Preferred contact method", values.preferredContactMethod || "—"],
    ["Club name", values.clubName],
    ["Facility type", facilityLabel + (values.facilityTypeOther ? ` (${values.facilityTypeOther})` : "")],
    ["Website", values.website || "—"],
    ["Court count", values.courtCount],
    ["Approximate Members or regular users", values.memberCount],
    ["Preferred operating model", modelLabel],
    ["Current process", values.currentProcess],
    ["Operational challenge", values.operationalChallenge],
    ["Additional details", values.additionalDetails || "—"],
  ];

  // Escaped for HTML — this is externally-submitted content rendered into
  // an email body, so it must never be trusted as raw markup.
  function esc(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  const html =
    `<h2>New pilot inquiry</h2><table cellpadding="4">` +
    rows.map(([k, v]) => `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v).replace(/\n/g, "<br/>")}</td></tr>`).join("") +
    `</table>`;

  const text = rows.map(([k, v]) => `${k}: ${v}`).join("\n");

  return {
    subject: `New Court Time pilot inquiry — ${values.clubName}`,
    html,
    text,
  };
}

// ─── Server Action ──────────────────────────────────────────────────────────

export async function submitPilotInquiryAction(
  _prevState: PilotInquiryState,
  formData: FormData
): Promise<PilotInquiryState> {
  // Honeypot — a hidden field a real visitor never sees or fills. Bots that
  // blanket-fill forms typically populate it. Pretend success without ever
  // touching the database or sending an email.
  if (str(formData, "company").length > 0) {
    return { status: "success", inquiryId: "ok" };
  }

  const values: PilotInquiryFormValues = {
    contactName: str(formData, "contactName"),
    email: str(formData, "email").toLowerCase(),
    clubName: str(formData, "clubName"),
    facilityType: str(formData, "facilityType"),
    facilityTypeOther: str(formData, "facilityTypeOther"),
    courtCount: str(formData, "courtCount"),
    memberCount: str(formData, "memberCount"),
    website: str(formData, "website"),
    preferredOperatingModel: str(formData, "preferredOperatingModel"),
    currentProcess: str(formData, "currentProcess"),
    operationalChallenge: str(formData, "operationalChallenge"),
    additionalDetails: str(formData, "additionalDetails"),
    phone: str(formData, "phone"),
    preferredContactMethod: str(formData, "preferredContactMethod"),
  };

  const errors: PilotInquiryFieldErrors = {};

  if (!values.contactName || values.contactName.length > 200) {
    errors.contactName = "Enter your name.";
  }

  if (!EMAIL_RE.test(values.email) || values.email.length > 320) {
    errors.email = "Enter a valid email address.";
  }

  if (!values.clubName || values.clubName.length > 200) {
    errors.clubName = "Enter your club or facility name.";
  }

  if (!FACILITY_TYPES.includes(values.facilityType as (typeof FACILITY_TYPES)[number])) {
    errors.facilityType = "Choose a facility type.";
  }
  if (values.facilityType === "other" && !values.facilityTypeOther) {
    errors.facilityTypeOther = "Briefly describe your facility type.";
  }
  if (values.facilityTypeOther.length > 200) {
    errors.facilityTypeOther = "Keep this under 200 characters.";
  }

  const courtCount = toRequiredInt(values.courtCount);
  if (courtCount === "invalid" || courtCount < 1 || courtCount > 500) {
    errors.courtCount = "Enter a number of courts from 1 to 500.";
  }

  const memberCount = toRequiredInt(values.memberCount);
  if (memberCount === "invalid" || memberCount < 0 || memberCount > 100000) {
    errors.memberCount = "Enter a number from 0 to 100,000 (0 is fine if your facility has no formal membership).";
  }

  if (values.website && (!URL_RE.test(values.website) || values.website.length > 500)) {
    errors.website = "Enter a full URL starting with http:// or https://.";
  }

  if (!OPERATING_MODELS.includes(values.preferredOperatingModel as (typeof OPERATING_MODELS)[number])) {
    errors.preferredOperatingModel = "Choose one of the three options.";
  }

  if (
    values.preferredContactMethod &&
    !CONTACT_METHODS.includes(values.preferredContactMethod as (typeof CONTACT_METHODS)[number])
  ) {
    errors.preferredContactMethod = "Choose a valid contact method.";
  }

  if (!values.currentProcess || values.currentProcess.length > 2000) {
    errors.currentProcess = values.currentProcess
      ? "Keep this under 2,000 characters."
      : "Tell us how you currently handle scheduling and events.";
  }
  if (!values.operationalChallenge || values.operationalChallenge.length > 2000) {
    errors.operationalChallenge = values.operationalChallenge
      ? "Keep this under 2,000 characters."
      : "Tell us your biggest operational challenge.";
  }
  if (values.additionalDetails.length > 4000) errors.additionalDetails = "Keep this under 4,000 characters.";
  if (values.phone.length > 40) errors.phone = "Keep this under 40 characters.";

  if (Object.keys(errors).length > 0) {
    return { status: "error", errors, values };
  }

  const fingerprint = await computeRequestFingerprint();

  // The RPC is granted only to service_role — this privileged client is the
  // only way to reach it. Fail closed if the secret isn't configured rather
  // than falling back to any lower-privilege client (there is no anon
  // fallback here: submit_pilot_inquiry is not grantable to anon).
  const supabase = createPrivilegedClient();
  if (!supabase) {
    console.error("pilot inquiry submission blocked: SUPABASE_SECRET_KEY is not configured");
    return {
      status: "error",
      errors: { form: "Something went wrong submitting your request. Please try again, or email hello@court-time.app." },
      values,
    };
  }

  const { data, error } = await supabase.rpc("submit_pilot_inquiry", {
    p_contact_name: values.contactName,
    p_email: values.email,
    p_club_name: values.clubName,
    p_facility_type: values.facilityType,
    p_court_count: courtCount as number,
    p_approximate_member_count: memberCount as number,
    p_current_process: values.currentProcess,
    p_operational_challenge: values.operationalChallenge,
    p_preferred_operating_model: values.preferredOperatingModel,
    p_facility_type_other: values.facilityTypeOther || null,
    p_phone: values.phone || null,
    p_preferred_contact_method: values.preferredContactMethod || null,
    p_website: values.website || null,
    p_additional_details: values.additionalDetails || null,
    p_source: "contact_page",
    p_fingerprint: fingerprint ?? null,
  });

  if (error?.message === "rate_limited") {
    return {
      status: "error",
      errors: {
        form: `Too many requests from this connection in the last ${FINGERPRINT_RATE_LIMIT_WINDOW_MINUTES} minutes. Please try again shortly, or email hello@court-time.app.`,
      },
      values,
    };
  }

  if (error || !data || data.length === 0) {
    // Safe diagnostic context only — never dump the full submission or any
    // secret into logs.
    console.error("submit_pilot_inquiry failed", { code: error?.code, message: error?.message });
    return {
      status: "error",
      errors: { form: "Something went wrong submitting your request. Please try again, or email hello@court-time.app." },
      values,
    };
  }

  const inquiryId = data[0].id as string;

  // Operator notification is best-effort — the durable record above is the
  // source of truth, so any failure here must never surface as a visitor-
  // facing error for a submission that already succeeded. Failure is logged
  // server-side only (inquiry id + provider error code/message), never
  // persisted — there is no anonymously-callable RPC to record it.
  if (!process.env.RESEND_API_KEY || !process.env.PILOT_INQUIRY_TO_EMAIL) {
    console.warn("pilot inquiry operator email skipped: not configured", { inquiryId });
  } else {
    const { subject, html, text } = buildOperatorEmail({
      inquiryId,
      createdAt: new Date().toISOString(),
      values,
    });
    const { messageId, error: emailError } = await sendEmail(
      process.env.PILOT_INQUIRY_TO_EMAIL,
      subject,
      html,
      text
    );
    if (!messageId) {
      console.error("pilot inquiry operator email failed", { inquiryId, error: emailError });
    }
  }

  return { status: "success", inquiryId };
}
