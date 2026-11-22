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
 * Names never depend on the pool's ordering unless no alias was configured.
 * An unconfigured account gets an ordinal, never an email-derived alias.
 */
export function resolveAccountShortName(
	account: { readonly shortName?: string } | undefined,
	indexOneBased: number,
): string {
	return sanitizeAccountShortName(account?.shortName) ??
		`A${Number.isFinite(indexOneBased) && indexOneBased >= 1 ? Math.trunc(indexOneBased) : 1}`;
}
