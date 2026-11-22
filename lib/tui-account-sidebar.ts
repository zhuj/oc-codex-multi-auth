import type { Rpc } from "@opencode/plugin/rpc";
import type { CodexStatusRpc } from "./opencode-v2-rpc.js";
import { formatQuotaPercent, type QuotaDisplayMode } from "./quota-display.js";
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
	compact?: boolean;
}

export interface SidebarTextFragment {
	readonly text: string;
	readonly bold?: boolean;
	readonly tone?: "muted" | "warning" | "danger" | "disabled";
}

// The host owns sidebar width. Keep normal rows compact and let its text node
// wrap if a future host or a narrower layout gives the section less room.
const SIDEBAR_LINE_COLUMNS = 35;

function formatResetCountdown(resetAtMs: number | undefined, now: number, compact = false): string | undefined {
	if (resetAtMs === undefined || !Number.isFinite(resetAtMs) || resetAtMs <= 0) return undefined;
	if (resetAtMs <= now) return "reset due";
	const duration = formatCompactDuration(resetAtMs - now);
	return duration && !compact ? `in ${duration}` : duration;
}

function quotaDetail(limit: NonNullable<TuiSidebarAccount["quota"]>["limits"][number] | undefined, mode: QuotaDisplayMode): SidebarTextFragment {
	const left = limit?.leftPercent;
	const validLeft = typeof left === "number" && Number.isFinite(left) && left >= 0 && left <= 100 ? left : undefined;
	return {
		text: validLeft === undefined ? "?" : formatQuotaPercent(Math.round(validLeft), mode),
		tone: validLeft === undefined || validLeft > 25 ? "muted" : validLeft > 10 ? "warning" : "danger",
	};
}

function compactQuotaDetails(quota: NonNullable<TuiSidebarAccount["quota"]>, options: TuiAccountSidebarOptions): SidebarTextFragment[] {
	const primary = quota.limits.find(({ label, windowMinutes }) => windowMinutes === 300 || label.toLowerCase() === "5h");
	const weekly = quota.limits.find(({ label, windowMinutes }) => windowMinutes === 10080 || /^(weekly|7d)$/i.test(label));
	const mode = options.quotaDisplay ?? "free";
	const weeklyDetail = quotaDetail(weekly, mode);
	const reset = options.showResetTimes ? formatResetCountdown(weekly?.resetAtMs, options.now ?? Date.now(), true) : undefined;
	if (!options.showQuota && !reset) return [];
	return [
		{ text: "\n  (", tone: "muted" },
		...(options.showQuota ? [quotaDetail(primary, mode), { text: "/", tone: "muted" } as const, weeklyDetail] : []),
		...(reset ? [{ ...weeklyDetail, text: `${options.showQuota ? " " : ""}${reset}` }] : []),
		{ text: ")", tone: "muted" },
	];
}

/** Format cached display data only; this never fetches quota or credentials. */
export function buildTuiAccountSidebar(
	accounts: readonly TuiSidebarAccount[],
	options: TuiAccountSidebarOptions = {},
): SidebarTextFragment[] {
	if (accounts.length === 0) return [{ text: "No Codex accounts in this pool." }];
	const glyphs = options.glyphs ?? resolveUiGlyphs("unicode");
	const mode = options.quotaDisplay ?? "free";
	const now = options.now ?? Date.now();
	const showDetails = options.showQuota || options.showResetTimes;
	return accounts.flatMap((account, position) => {
		const index = Number.isSafeInteger(account.index) && account.index > 0 ? account.index : "?";
		const prefix = `${account.active ? glyphs.active : glyphs.inactive} ${index}. `;
		const suffix = account.enabled ? "" : " (disabled)";
		// An explicit empty display name is the service's `accountNames: none`
		// selection. Only an absent field falls back to the older label contract.
		const name = account.displayName === "" ? ""
			: sanitizeDisplayText(account.displayName) ?? sanitizeDisplayText(account.label) ?? "unknown";
		const nameWidth = Math.max(3, SIDEBAR_LINE_COLUMNS - displayWidth(prefix + suffix));
		const fragments: SidebarTextFragment[] = [{ text: `${position === 0 ? "" : "\n"}${name ? prefix : prefix.trimEnd()}` }];
		if (name) fragments.push({ text: truncateToDisplayWidth(name, nameWidth, glyphs.ellipsis), ...(showDetails && { bold: true }) });
		if (suffix) fragments.push({ text: suffix, tone: "disabled" });
		if (!showDetails) return fragments;
		const quota = account.quota;
		if (!quota || quota.limits.length === 0) {
			fragments.push({ text: "\n  quota unavailable", tone: "muted" });
		} else if (options.compact) {
			fragments.push(...compactQuotaDetails(quota, { ...options, now }));
		} else {
			for (const limit of quota.limits) {
				const reset = options.showResetTimes ? formatResetCountdown(limit.resetAtMs, now) : undefined;
				const reading = quotaDetail(limit, mode);
				const percent = options.showQuota ? `${reading.text}${mode === "used" && reading.text !== "?" ? " used" : ""}` : undefined;
				// An untouched window has no reset timestamp; do not invent one
				// from its nominal length or display it as already reset.
				if (!percent && !reset) continue;
				const windowLabel = sanitizeDisplayText(limit.label) ?? "quota";
				const label = windowLabel.toLowerCase() === "weekly" ? "7d" : windowLabel;
				const detail = [percent, reset].filter(Boolean).join(percent && reset === "reset due" ? ", " : " ");
				const labelWidth = Math.max(3, SIDEBAR_LINE_COLUMNS - displayWidth(`  (: ${detail})`));
				fragments.push({ ...reading, text: `\n  (${truncateToDisplayWidth(label, labelWidth, glyphs.ellipsis)}: ${detail})` });
			}
		}
		if (quota?.stale || quota?.readFailed) {
			const warnings = [quota.stale ? "stale quota" : "", quota.readFailed ? "refresh failed" : ""].filter(Boolean);
			fragments.push({ text: `\n  ${warnings.join("; ")}`, tone: "muted" });
		}
		return fragments;
	});
}

export function formatTuiAccountSidebar(accounts: readonly TuiSidebarAccount[], options?: TuiAccountSidebarOptions): string {
	return buildTuiAccountSidebar(accounts, options).map(({ text }) => text).join("");
}
