// Server-only. Inline HTML templates for all 8 notification kinds.
// Each exported function returns { subject, html, text }.
// The plain-text version is included for accessibility and clients that
// don't render HTML.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://court-time.vercel.app";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(
  clubName: string,
  body:     string,
  ctaLabel: string,
  ctaUrl:   string,
): { html: string; text: string } {
  return {
    html: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e5e7eb">
  <p style="margin:0 0 16px;font-size:11px;font-weight:600;letter-spacing:.06em;color:#9ca3af;text-transform:uppercase">${esc(clubName)}</p>
  <p style="margin:0 0 28px;font-size:15px;color:#111827;line-height:1.6">${esc(body)}</p>
  <a href="${esc(ctaUrl)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:500">${esc(ctaLabel)}</a>
  <p style="margin:28px 0 0;font-size:11px;color:#9ca3af">Manage email preferences: Profile → Notification preferences in the Court Time app.</p>
</div>
</body>
</html>`,
    text: `${clubName}\n\n${body}\n\n${ctaLabel}:\n${ctaUrl}\n\n---\nManage email preferences: Profile → Notification preferences in the Court Time app.`,
  };
}

export function reservationConfirmedTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View calendar", `${APP_URL}/calendar`);
  return { subject: `Court booked — ${clubName}`, html, text };
}

export function reservationCancelledByMemberTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View calendar", `${APP_URL}/calendar`);
  return { subject: `Booking cancelled — ${clubName}`, html, text };
}

export function reservationCancelledByAdminTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View calendar", `${APP_URL}/calendar`);
  return { subject: `Your booking was cancelled — ${clubName}`, html, text };
}

export function reservationRescheduledTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View calendar", `${APP_URL}/calendar`);
  return { subject: `Booking rescheduled — ${clubName}`, html, text };
}

export function eventJoinedTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View calendar", `${APP_URL}/calendar`);
  return { subject: `You're in — ${clubName}`, html, text };
}

export function eventCancelledTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View calendar", `${APP_URL}/calendar`);
  return { subject: `Event cancelled — ${clubName}`, html, text };
}

export function eventUpdatedTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View calendar", `${APP_URL}/calendar`);
  return { subject: `Event updated — ${clubName}`, html, text };
}

export function waitlistOfferTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "Accept now", `${APP_URL}/calendar`);
  return { subject: `Spot available — ${clubName}`, html, text };
}

export function waitlistPromotedTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View calendar", `${APP_URL}/calendar`);
  return { subject: `You're confirmed — ${clubName}`, html, text };
}

export function announcementTemplate(
  clubName:          string,
  announcementTitle: string,
  body:              string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "Open Court Time", `${APP_URL}/calendar`);
  return { subject: `${announcementTitle} — ${clubName}`, html, text };
}

export function lessonRequestReceivedTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View requests", `${APP_URL}/events?tab=lessons`);
  return { subject: `New lesson request — ${clubName}`, html, text };
}

export function lessonRequestProposedTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "Review proposal", `${APP_URL}/lessons`);
  return { subject: `Lesson time proposed — ${clubName}`, html, text };
}

export function lessonRequestConfirmedTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View My Bookings", `${APP_URL}/lessons`);
  return { subject: `Lesson confirmed — ${clubName}`, html, text };
}

export function lessonRequestDeclinedTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View My Bookings", `${APP_URL}/lessons`);
  return { subject: `Lesson request declined — ${clubName}`, html, text };
}

export function lessonCancelledTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View My Bookings", `${APP_URL}/lessons`);
  return { subject: `Lesson cancelled — ${clubName}`, html, text };
}

export function lessonProviderReassignedTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View My Bookings", `${APP_URL}/lessons`);
  return { subject: `Lesson request updated — ${clubName}`, html, text };
}

export function lessonAdminRequestedTemplate(
  clubName: string,
  body:     string,
): { subject: string; html: string; text: string } {
  const { html, text } = layout(clubName, body, "View My Bookings", `${APP_URL}/lessons`);
  return { subject: `Lesson request submitted for you — ${clubName}`, html, text };
}
