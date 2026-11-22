import { getModelPoolAccountKey, type ModelPoolAccount } from "./accounts/pool-identity.js";
import { sanitizeDisplayText, truncateToDisplayWidth } from "./ui/display-text.js";

/** How the active account is identified on the compact status line. */
export type AccountNameMode = "short" | "full" | "number" | "none";

export const ACCOUNT_SHORT_NAME_MAX_COLUMNS = 16;

/** Plain text only; brackets belong to the renderer, not the configured alias. */
export function sanitizeAccountShortName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const safe = sanitizeDisplayText(value, { maxLength: 256 })
		?.replace(/[\[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return safe ? truncateToDisplayWidth(safe, ACCOUNT_SHORT_NAME_MAX_COLUMNS, "").trim() || undefined : undefined;
}

/**
 * Stable seat keys take precedence over workspace ids and exact email keys.
 * Names never depend on the pool's ordering unless no alias was configured.
 * An unconfigured account gets an ordinal, never an email-derived alias.
 */
export function resolveAccountShortName(
	account: ModelPoolAccount & { email?: string },
	indexOneBased: number,
	aliases: Readonly<Record<string, string>> = {},
): string {
	const keys = [getModelPoolAccountKey(account), account.accountId?.trim(), account.email?.trim()];
	for (const key of keys) {
		if (!key || !Object.hasOwn(aliases, key)) continue;
		const name = sanitizeAccountShortName(aliases[key]);
		if (name) return name;
	}
	return `A${Number.isFinite(indexOneBased) && indexOneBased >= 1 ? Math.trunc(indexOneBased) : 1}`;
}
