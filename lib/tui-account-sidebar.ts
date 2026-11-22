import type { Rpc } from "@opencode/plugin/rpc";
import type { CodexStatusRpc } from "./opencode-v2-rpc.js";
import { formatNamedQuotaPercent, type QuotaDisplayMode } from "./quota-display.js";
import { formatCompactDuration } from "./quota-overview.js";
import { displayWidth, sanitizeDisplayText, truncateToDisplayWidth } from "./ui/display-text.js";
import { resolveUiGlyphs, type UiGlyphSet } from "./ui/theme.js";

export type TuiSidebarAccount = Rpc.Output<typeof CodexStatusRpc.methods.status.output>["accounts"][number];

export interface TuiAccountSidebarOptions {
	showQuota?: boolean;
	showResetTimes?: boolean;
	quotaDisplay?: QuotaDisplayMode;
	glyphs?: Pick<UiGlyphSet, "active" | "inactive" | "ellipsis">;
	now?: number;
}

// The host owns sidebar width. Keep normal rows compact and let its text node
// wrap if a future host or a narrower layout gives the section less room.
const SIDEBAR_LINE_COLUMNS = 35;

function formatResetCountdown(resetAtMs: number | undefined, now: number): string | undefined {
	if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || resetAtMs <= 0) return undefined;
	if (resetAtMs <= now) return "reset due";
	const duration = formatCompactDuration(resetAtMs - now);
	return duration ? `resets in ${duration}` : undefined;
}

/** Format cached display data only; this never fetches quota or credentials. */
export function formatTuiAccountSidebar(
	accounts: readonly TuiSidebarAccount[],
	options: TuiAccountSidebarOptions = {},
): string {
	if (accounts.length === 0) return "No Codex accounts in this pool.";
	const glyphs = options.glyphs ?? resolveUiGlyphs("unicode");
	const mode = options.quotaDisplay ?? "free";
	const now = options.now ?? Date.now();
	return accounts.flatMap((account) => {
		const index = Number.isSafeInteger(account.index) && account.index > 0 ? account.index : "?";
		const prefix = `${account.active ? glyphs.active : glyphs.inactive} ${index}. `;
		const suffix = account.enabled ? "" : " (disabled)";
		// An explicit empty display name is the service's `accountNames: none`
		// selection. Only an absent field falls back to the older label contract.
		const name = account.displayName === "" ? ""
			: sanitizeDisplayText(account.displayName) ?? sanitizeDisplayText(account.label) ?? "unknown";
		const nameWidth = Math.max(3, SIDEBAR_LINE_COLUMNS - displayWidth(prefix + suffix));
		const lines = [name ? `${prefix}${truncateToDisplayWidth(name, nameWidth, glyphs.ellipsis)}${suffix}` : `${prefix.trimEnd()}${suffix}`];
		if (!options.showQuota && !options.showResetTimes) return lines;
		const quota = account.quota;
		if (!quota || quota.limits.length === 0) {
			lines.push("  quota unavailable");
		} else {
			for (const limit of quota.limits) {
				const reset = options.showResetTimes ? formatResetCountdown(limit.resetAtMs, now) : undefined;
				const parts: string[] = [];
				if (options.showQuota) {
					const left = limit.leftPercent;
					parts.push(typeof left === "number" && Number.isFinite(left) && left >= 0 && left <= 100
						? formatNamedQuotaPercent(Math.round(left), mode)
						: `? ${mode === "used" ? "used" : "left"}`);
				}
				if (reset) parts.push(reset);
				// An untouched window has no reset timestamp; do not invent one
				// from its nominal length or display it as already reset.
				if (parts.length === 0) continue;
				const label = sanitizeDisplayText(limit.label) ?? "quota";
				const detail = parts.join(", ");
				const labelWidth = Math.max(3, SIDEBAR_LINE_COLUMNS - displayWidth(`   ${detail}`));
				lines.push(`  ${truncateToDisplayWidth(label, labelWidth, glyphs.ellipsis)} ${detail}`);
			}
		}
		if (quota?.stale || quota?.readFailed) {
			lines.push(`  ${[quota.stale ? "stale quota" : "", quota.readFailed ? "refresh failed" : ""].filter(Boolean).join("; ")}`);
		}
		return lines;
	}).join("\n");
}
