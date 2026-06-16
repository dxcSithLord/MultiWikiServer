import type { AuthUser } from "./sessions";

/**
 * Audit logging (access-model Batch 4).
 *
 * `recordAudit` is the single sink: every administrative, structural, and
 * authentication event funnels through it to write one `audit_log` row.
 *
 * IMPORTANT — pass `state.engine` (the root client), NOT a request transaction
 * client, so that "denied"/"error"/failed-login rows are recorded durably even
 * when the request's own transaction rolls back. Audit logging must NEVER break a
 * request: write failures are swallowed (logged to stderr).
 *
 * NEVER record secrets, OPAQUE material, session ids/keys, passwords, or raw
 * headers — `detail` is for small non-sensitive context only.
 */

export type AuditAction =
  | "user.create" | "user.update" | "user.delete" | "user.set_disabled" | "user.temp_password"
  | "role.create" | "role.update"
  | "recipe.create" | "recipe.update" | "recipe.delete" | "recipe.acl_update"
  | "bag.create" | "bag.update" | "bag.delete" | "bag.acl_update"
  | "login.success" | "login.failure" | "login.lockout" | "sso.login" | "logout";

export type AuditOutcome = "success" | "denied" | "error";

export interface AuditEvent {
  action: AuditAction;
  outcome: AuditOutcome;
  actor_user_id?: string | null;
  actor_label: string;
  target_type?: string | null;
  target_id?: string | null;
  target_name?: string | null;
  detail?: PrismaJson.AuditLog_detail;
  source?: string | null;
}

/** Max stored length for free-text labels (e.g. an attacker-supplied login username). */
const LABEL_MAX = 200;

const clip = (s: string) => (s.length > LABEL_MAX ? s.slice(0, LABEL_MAX) : s);

/** Derive a stable, non-sensitive actor label from the request user. */
export function actorLabel(user?: Pick<AuthUser, "isLoggedIn" | "username" | "user_id"> | null): string {
  if (!user || !user.isLoggedIn) return "anon";
  return clip(user.username || (user.user_id ? `user:${user.user_id}` : "anon"));
}

/**
 * Keys whose VALUE must never be persisted, matched case-insensitively as a substring.
 * Covers passwords, secrets/tokens, OPAQUE material, session ids/keys, signatures,
 * credentials, and raw-header families (authorization/bearer/cookie/api-key).
 */
const SENSITIVE_KEY = /pass|secret|token|opaque|session_?key|session_?id|signature|credential|cookie|authorization|bearer|api[_-]?key|registration|header/i;
const REDACTED = "[redacted]";

/** Recursively mask the values of sensitive keys at any depth (objects + arrays). */
function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Defence-in-depth: redact sensitive values from a detail bag at the sink, so a
 * careless caller can never leak a secret into the audit log. Returns a new
 * structure with matching keys' values replaced by "[redacted]" at every level
 * (the declared type is a flat scalar map, but this stays robust if a caller
 * passes nested objects/arrays via `any`); non-matching values are kept.
 */
export function redactDetail(detail?: PrismaJson.AuditLog_detail): PrismaJson.AuditLog_detail | undefined {
  if (!detail || typeof detail !== "object") return detail;
  return redactValue(detail) as PrismaJson.AuditLog_detail;
}

/** The single audit sink. Writes one row; swallows errors so it never breaks the request. */
export async function recordAudit(engine: PrismaTxnClient, event: AuditEvent): Promise<void> {
  try {
    await engine.auditLog.create({
      data: {
        actor_user_id: event.actor_user_id ?? null,
        actor_label: clip(event.actor_label),
        action: event.action,
        target_type: event.target_type ?? null,
        target_id: event.target_id ?? null,
        target_name: event.target_name ?? null,
        outcome: event.outcome,
        detail: redactDetail(event.detail) ?? undefined,
        source: event.source ?? null,
      },
    });
  } catch (err) {
    console.error("[audit] failed to write audit row:", (err as Error)?.message ?? err);
  }
}
