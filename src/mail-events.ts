import { mailSenderDomain, processMailEvent, type MailEnv, type MailEventType } from "./email";

type EventEnv = MailEnv & { MAIL_EVENTS_QUEUE?: string; MAIL_EVENTS_ACCOUNT_ID?: string };
type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : null;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[^\s\x00-\x1f\x7f]{1,256}$/.test(value);
}

const TYPES: Record<string, MailEventType> = {
  "cf.email.sending.message.delivered": "delivered",
  "cf.email.sending.message.bounced": "bounced",
  "cf.email.sending.message.complained": "complained",
  "cf.email.sending.message.failed": "failed",
  "cf.email.sending.message.rejected": "failed",
};

function normalizedEvent(body: unknown, domain: string, accountId?: string): { id: string; messageId: string; type: MailEventType; timestamp: number } | null {
  const event = object(body);
  if (!event || typeof event.type !== "string" || !Object.hasOwn(TYPES, event.type)) return null;
  const source = object(event.source), payload = object(event.payload), metadata = object(event.metadata);
  if (!source || !payload || !metadata || source.type !== "email.sending" || source.domain !== domain || !identifier(source.zoneId)) return null;
  if (metadata.eventSchemaVersion !== 1 || !identifier(metadata.accountId) || !identifier(metadata.eventSubscriptionId) || (accountId && metadata.accountId !== accountId)) return null;
  if (!identifier(payload.eventId) || !identifier(payload.messageId) || payload.terminal !== true) return null;
  const suffix = event.type.slice("cf.email.sending.message.".length);
  if (object(payload.delivery)?.status !== suffix) return null;
  const time = metadata.eventTimestamp;
  if (typeof time !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(time)) return null;
  const timestamp = Date.parse(time);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  return { id: payload.eventId, messageId: payload.messageId, type: TYPES[event.type], timestamp };
}

/** Only the configured platform Queue is trusted; no HTTP delivery-event endpoint exists. */
export async function consumeMailEvents(batch: MessageBatch<unknown>, env: EventEnv): Promise<void> {
  if (!env.MAIL_EVENTS_QUEUE || batch.queue !== env.MAIL_EVENTS_QUEUE) {
    batch.retryAll();
    return;
  }
  let domain: string;
  try { domain = mailSenderDomain(env); }
  catch { batch.retryAll(); return; }
  for (const message of batch.messages) {
    const event = normalizedEvent(message.body, domain, env.MAIL_EVENTS_ACCOUNT_ID);
    if (!event) { message.ack(); continue; }
    try {
      // Persist only IDs, the normalized terminal status and provider timestamp.
      // Recipient, sender, subject and SMTP diagnostic text never enter our database or logs.
      await processMailEvent(env, event);
      message.ack();
    } catch { message.retry(); }
  }
}
