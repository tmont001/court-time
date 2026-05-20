// Server-only. Do not import from client components.
import twilio from "twilio";

export async function sendSms(
  to: string,
  body: string
): Promise<{ sid: string | null; error: string | null }> {
  const accountSid  = process.env.TWILIO_ACCOUNT_SID;
  const authToken   = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber  = process.env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    return { sid: null, error: "SMS is not configured." };
  }

  try {
    const message = await twilio(accountSid, authToken).messages.create({
      to,
      from: fromNumber,
      body,
    });
    return { sid: message.sid, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { sid: null, error: message };
  }
}
