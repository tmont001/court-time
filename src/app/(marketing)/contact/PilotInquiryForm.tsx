"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { submitPilotInquiryAction } from "./actions";
import { initialPilotInquiryState, type PilotInquiryState } from "./formState";

const FACILITY_TYPES: { value: string; label: string }[] = [
  { value: "private_club", label: "Private club" },
  { value: "country_club", label: "Country club" },
  { value: "hoa_residential", label: "HOA or residential community" },
  { value: "public_municipal", label: "Public or municipal facility" },
  { value: "tennis_academy", label: "Tennis academy" },
  { value: "school_university", label: "School or university" },
  { value: "other", label: "Other" },
];

// Exactly three — 'hybrid' was removed. 'not_sure' is the honest, valid
// answer for a visitor who hasn't decided yet, not an implicit fourth option.
const OPERATING_MODELS: { value: string; title: string; body: string }[] = [
  {
    value: "staff_managed",
    title: "Staff-managed",
    body: "Our staff would manage court bookings, events, Member records, and communication. Members would not need Court Time accounts.",
  },
  {
    value: "member_self_service",
    title: "Member self-service",
    body: "Our authenticated club Members would use Court Time to reserve courts, join events and programs, manage waitlists, and request lessons, while staff retains administrative oversight.",
  },
  {
    value: "not_sure",
    title: "Not sure yet",
    body: "We would like help deciding which approach fits our club.",
  },
];

const CONTACT_METHODS: { value: string; label: string }[] = [
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" },
  { value: "either", label: "Either" },
];

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
      {message}
    </p>
  );
}

const labelCls = "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";
const optionalCls = "font-normal text-gray-400 dark:text-gray-500";

export default function PilotInquiryForm() {
  const [state, formAction, isPending] = useActionState<PilotInquiryState, FormData>(
    submitPilotInquiryAction,
    initialPilotInquiryState
  );
  const [facilityType, setFacilityType] = useState(
    state.status === "error" ? state.values.facilityType : ""
  );

  const errors = state.status === "error" ? state.errors : {};
  const values = state.status === "error" ? state.values : undefined;

  if (state.status === "success") {
    return (
      <div
        role="status"
        aria-live="polite"
        className="rounded-xl border-2 border-gray-900 dark:border-gray-100 bg-white dark:bg-gray-800 px-6 py-8 text-center"
      >
        <p className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
          Your inquiry was received.
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed max-w-md mx-auto mb-1">
          We personally review every pilot request. If it looks like a fit,
          we&apos;ll follow up by email to set up a conversation — reaching out
          isn&apos;t a commitment on either side.
        </p>
        <p className="text-xs text-gray-400 dark:text-gray-500 mb-6">
          Prefer email? Reach us anytime at{" "}
          <a href="mailto:hello@court-time.app" className="underline underline-offset-2">
            hello@court-time.app
          </a>
          .
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link
            href="/features"
            className="w-full sm:w-auto px-5 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
          >
            See what Court Time helps you manage
          </Link>
          <Link
            href="/pricing"
            className="w-full sm:w-auto px-5 py-2.5 rounded-xl border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-900 dark:hover:text-gray-100 motion-safe:transition-all motion-safe:duration-150"
          >
            Check pricing
          </Link>
        </div>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate className="space-y-5">

      {/* Honeypot — hidden from sighted users and assistive tech; bots that
          blanket-fill forms tend to populate it. */}
      <div className="absolute -left-[9999px] w-px h-px overflow-hidden" aria-hidden="true">
        <label htmlFor="company">Company</label>
        <input id="company" name="company" type="text" tabIndex={-1} autoComplete="off" />
      </div>

      {errors.form && (
        <div
          role="alert"
          className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-700 px-4 py-3"
        >
          <p className="text-sm text-red-700 dark:text-red-400">{errors.form}</p>
        </div>
      )}

      {/* Contact */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="contactName" className={labelCls}>Your name</label>
          <input
            id="contactName" name="contactName" type="text" required maxLength={200}
            defaultValue={values?.contactName}
            aria-invalid={!!errors.contactName}
            aria-describedby={errors.contactName ? "contactName-error" : undefined}
            className="ct-input"
          />
          <FieldError id="contactName-error" message={errors.contactName} />
        </div>
        <div>
          <label htmlFor="email" className={labelCls}>Work email</label>
          <input
            id="email" name="email" type="email" required maxLength={320}
            defaultValue={values?.email}
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "email-error" : undefined}
            className="ct-input"
          />
          <FieldError id="email-error" message={errors.email} />
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="phone" className={labelCls}>Phone <span className={optionalCls}>(optional)</span></label>
          <input
            id="phone" name="phone" type="tel" maxLength={40}
            defaultValue={values?.phone}
            aria-invalid={!!errors.phone}
            aria-describedby={errors.phone ? "phone-error" : undefined}
            className="ct-input"
          />
          <FieldError id="phone-error" message={errors.phone} />
        </div>
        <div>
          <label htmlFor="preferredContactMethod" className={labelCls}>
            Preferred contact method <span className={optionalCls}>(optional)</span>
          </label>
          <select
            id="preferredContactMethod" name="preferredContactMethod"
            defaultValue={values?.preferredContactMethod ?? ""}
            aria-invalid={!!errors.preferredContactMethod}
            aria-describedby={errors.preferredContactMethod ? "preferredContactMethod-error" : undefined}
            className="ct-input"
          >
            <option value="">No preference</option>
            {CONTACT_METHODS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <FieldError id="preferredContactMethod-error" message={errors.preferredContactMethod} />
        </div>
      </div>

      {/* Club */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="clubName" className={labelCls}>Club or facility name</label>
          <input
            id="clubName" name="clubName" type="text" required maxLength={200}
            defaultValue={values?.clubName}
            aria-invalid={!!errors.clubName}
            aria-describedby={errors.clubName ? "clubName-error" : undefined}
            className="ct-input"
          />
          <FieldError id="clubName-error" message={errors.clubName} />
        </div>
        <div>
          <label htmlFor="facilityType" className={labelCls}>Club or facility type</label>
          <select
            id="facilityType" name="facilityType" required
            value={facilityType}
            onChange={(e) => setFacilityType(e.target.value)}
            aria-invalid={!!errors.facilityType}
            aria-describedby={errors.facilityType ? "facilityType-error" : undefined}
            className="ct-input"
          >
            <option value="" disabled>Choose one</option>
            {FACILITY_TYPES.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <FieldError id="facilityType-error" message={errors.facilityType} />
        </div>
      </div>

      {facilityType === "other" && (
        <div>
          <label htmlFor="facilityTypeOther" className={labelCls}>
            Briefly describe your facility type
          </label>
          <input
            id="facilityTypeOther" name="facilityTypeOther" type="text" maxLength={200} required
            defaultValue={values?.facilityTypeOther}
            aria-invalid={!!errors.facilityTypeOther}
            aria-describedby={errors.facilityTypeOther ? "facilityTypeOther-error" : undefined}
            className="ct-input"
          />
          <FieldError id="facilityTypeOther-error" message={errors.facilityTypeOther} />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label htmlFor="courtCount" className={labelCls}>Number of courts</label>
          <input
            id="courtCount" name="courtCount" type="number" inputMode="numeric" min={1} max={500} required
            defaultValue={values?.courtCount}
            aria-invalid={!!errors.courtCount}
            aria-describedby={errors.courtCount ? "courtCount-error" : undefined}
            className="ct-input"
          />
          <FieldError id="courtCount-error" message={errors.courtCount} />
        </div>
        <div>
          <label htmlFor="memberCount" className={labelCls}>Approximate number of Members or regular users</label>
          <input
            id="memberCount" name="memberCount" type="number" inputMode="numeric" min={0} max={100000} required
            defaultValue={values?.memberCount}
            aria-invalid={!!errors.memberCount}
            aria-describedby={errors.memberCount ? "memberCount-error memberCount-hint" : "memberCount-hint"}
            className="ct-input"
          />
          <p id="memberCount-hint" className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            0 is fine if your facility doesn&apos;t have formal membership.
          </p>
          <FieldError id="memberCount-error" message={errors.memberCount} />
        </div>
      </div>

      <div>
        <label htmlFor="website" className={labelCls}>Website <span className={optionalCls}>(optional)</span></label>
        <input
          id="website" name="website" type="url" maxLength={500} placeholder="https://"
          defaultValue={values?.website}
          aria-invalid={!!errors.website}
          aria-describedby={errors.website ? "website-error" : undefined}
          className="ct-input"
        />
        <FieldError id="website-error" message={errors.website} />
      </div>

      {/* Discovery */}
      <div>
        <label htmlFor="currentProcess" className={labelCls}>
          How do you currently handle scheduling and events?
        </label>
        <textarea
          id="currentProcess" name="currentProcess" rows={3} required maxLength={2000}
          defaultValue={values?.currentProcess}
          aria-invalid={!!errors.currentProcess}
          aria-describedby={errors.currentProcess ? "currentProcess-error" : undefined}
          className="ct-input"
        />
        <FieldError id="currentProcess-error" message={errors.currentProcess} />
      </div>

      <div>
        <label htmlFor="operationalChallenge" className={labelCls}>
          What&apos;s your biggest operational challenge right now?
        </label>
        <textarea
          id="operationalChallenge" name="operationalChallenge" rows={3} required maxLength={2000}
          defaultValue={values?.operationalChallenge}
          aria-invalid={!!errors.operationalChallenge}
          aria-describedby={errors.operationalChallenge ? "operationalChallenge-error" : undefined}
          className="ct-input"
        />
        <FieldError id="operationalChallenge-error" message={errors.operationalChallenge} />
      </div>

      {/* Preferred operating model */}
      <fieldset>
        <legend className={labelCls}>Preferred operating model</legend>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          Clubs use Court Time differently. Some prefer staff to manage the
          calendar and Member activity, while others give Members
          self-service access. Tell us which approach best fits your club
          today.
        </p>
        <div className="space-y-2">
          {OPERATING_MODELS.map((m) => (
            <label
              key={m.value}
              className="flex items-start gap-3 rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2.5 cursor-pointer hover:border-gray-400 dark:hover:border-gray-500 motion-safe:transition-colors motion-safe:duration-150 has-[:checked]:border-gray-900 dark:has-[:checked]:border-gray-100"
            >
              <input
                type="radio"
                name="preferredOperatingModel"
                value={m.value}
                required
                defaultChecked={values?.preferredOperatingModel === m.value}
                aria-describedby={errors.preferredOperatingModel ? "preferredOperatingModel-error" : undefined}
                className="mt-0.5 shrink-0"
              />
              <span>
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{m.title}</span>
                <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">{m.body}</span>
              </span>
            </label>
          ))}
        </div>
        <FieldError id="preferredOperatingModel-error" message={errors.preferredOperatingModel} />
      </fieldset>

      <div>
        <label htmlFor="additionalDetails" className={labelCls}>
          Anything else we should know? <span className={optionalCls}>(optional)</span>
        </label>
        <textarea
          id="additionalDetails" name="additionalDetails" rows={3} maxLength={4000}
          defaultValue={values?.additionalDetails}
          aria-invalid={!!errors.additionalDetails}
          aria-describedby={errors.additionalDetails ? "additionalDetails-error" : undefined}
          className="ct-input"
        />
        <FieldError id="additionalDetails-error" message={errors.additionalDetails} />
      </div>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        Submitting is not a commitment — it starts a conversation. No account
        is created and nothing is billed.
      </p>

      <p className="text-xs text-gray-400 dark:text-gray-500">
        We&rsquo;ll use this information to respond to your pilot request.
        See our{" "}
        <Link href="/privacy" className="underline underline-offset-2 hover:text-gray-600 dark:hover:text-gray-300">
          Privacy Policy
        </Link>
        .
      </p>

      <button
        type="submit"
        disabled={isPending}
        className="w-full py-3 rounded-xl bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 text-sm font-semibold hover:bg-gray-700 dark:hover:bg-gray-300 disabled:opacity-50 disabled:cursor-not-allowed motion-safe:transition-all motion-safe:duration-150"
      >
        {isPending ? "Submitting…" : "Request a pilot"}
      </button>
    </form>
  );
}
