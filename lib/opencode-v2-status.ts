import { dirname, join } from "node:path";
import {
	getCodexTuiGlyphMode,
	getCodexTuiMaskEmail,
	getCodexTuiMaskEmailInQuotaDetails,
	getQuotaDisplay,
	getQuotaRefresh,
	getQuotaSidebar,
	getQuotaStatus,
	loadPluginConfig,
} from "./config.js";
import { fetchTuiQuotaOverview, toQuotaOverviewAccounts } from "./tui-quota-overview.js";
import {
	isFreshTuiQuotaSnapshot,
	readTuiQuotaSnapshot,
	TUI_QUOTA_CACHE_VERSION,
	TUI_QUOTA_OVERVIEW_CACHE_FILE,
	type TuiQuotaOverviewAccount,
	type TuiQuotaOverviewSnapshot,
	type TuiQuotaSnapshot,
} from "./tui-quota-cache.js";
import {
	formatPromptStatusText,
	formatQuotaDetailsText,
	formatQuotaCreditsStatusLines,
	formatQuotaOverviewStatusLines,
	formatQuotaResetsStatusLines,
	maskEmailsInText,
	resolveQuotaOverviewTone,
	resolveQuotaPromptTone,
	withStatusPrefix,
	type CompactQuotaStatus,
} from "./tui-status.js";
import { getStoragePath, loadAccounts, type AccountMetadataV3 } from "./storage.js";
import { getCurrentProjectRoot } from "./storage/state.js";
import { createUsageAccountFingerprint } from "./codex-usage.js";
import { resolveDisplayEmail } from "./account-display.js";
import { resolveAccountShortName } from "./account-short-name.js";
import { isFiveHourQuotaWindow, isWeeklyQuotaWindow } from "./quota-windows.js";
import { displayWidth, sanitizeDisplayText } from "./ui/display-text.js";

// Kept for callers of the old test hook. The shared fetcher now owns the budget.
export { resetTuiQuotaOverviewThrottle as resetV2StatusThrottle } from "./tui-quota-overview.js";

/** Attribute cache rows by identity, never by a position left over from a prior pool. */
function resolveAccountReading(
	account: AccountMetadataV3,
	index: number,
	overview: TuiQuotaOverviewSnapshot | undefined,
	latest: TuiQuotaSnapshot | undefined,
): TuiQuotaOverviewAccount | undefined {
	const fingerprint = createUsageAccountFingerprint(account);
	const cached = overview?.accounts.find((row) => row.fingerprint === fingerprint);
	const fetchedAt = cached?.fetchedAt ?? overview?.fetchedAt;
	const useLatest = latest?.fingerprint === fingerprint && latest.limits.length > 0 &&
		(!cached || fetchedAt === undefined || latest.fetchedAt > fetchedAt);
	if (!cached && !useLatest) return undefined;
	const reading = useLatest && latest ? {
		...cached,
		fingerprint,
		limits: latest.limits,
		planType: latest.planType ?? cached?.planType,
		fetchedAt: latest.fetchedAt,
		// Only a later observation proves recovery from an earlier read failure.
		...(cached?.readFailedAt === undefined || latest.fetchedAt > cached.readFailedAt
			? { readFailedAt: undefined, readFailedSince: undefined, readError: undefined }
			: {}),
	} : cached;
	if (!reading) return undefined;
	return {
		...reading, index: index + 1,
		fetchedAt: reading.fetchedAt ?? fetchedAt,
		email: account.email, label: account.accountLabel,
	};
}

function isStaleReading(reading: TuiQuotaOverviewAccount, now: number, intervalMs: number): boolean {
	return reading.readFailedAt !== undefined || reading.fetchedAt === undefined ||
		now - reading.fetchedAt >= intervalMs;
}

/** Format on the server so remote TUIs never need access to credentials. */
export async function readV2Status({ width }: { width: number }) {
	const config = loadPluginConfig();
	const status = getQuotaStatus(config);
	const sidebar = getQuotaSidebar(config);
	const refresh = getQuotaRefresh(config);
	const quotaDisplay = getQuotaDisplay(config);
	const maskEmail = getCodexTuiMaskEmail(config);
	const glyphMode = getCodexTuiGlyphMode(config);
	const now = Date.now();
	const [snapshot, pool] = await Promise.all([readTuiQuotaSnapshot(), loadAccounts()]);
	const accounts = pool?.accounts ?? [];
	const snapshotIndex = snapshot
		? accounts.findIndex((account) => createUsageAccountFingerprint(account) === snapshot.fingerprint)
		: -1;
	// A global header reading describes quota for the same seat in any pool,
	// but only the global pool may use it to attribute which account is serving.
	const servingIndex = !getCurrentProjectRoot() && snapshot?.source === "headers" &&
		isFreshTuiQuotaSnapshot(snapshot, now) && snapshotIndex >= 0 ? snapshotIndex : undefined;
	const activeIndex = servingIndex ?? pool?.activeIndex ?? -1;
	const active = accounts[activeIndex];
	const activeSnapshot = snapshotIndex === activeIndex && snapshotIndex >= 0 ? snapshot : undefined;
	const wantsPool = status.screens.some((screen) => screen !== "active") ||
		(sidebar.enabled && (sidebar.showQuota || sidebar.showResetTimes));
	// This is the single pool producer for both slots. The shared fetcher gates
	// attempts (including failures), coalesces concurrent readers and supports
	// cache-only mode. A local RPC tick is never itself permission to fetch.
	const rawOverview = accounts.length > 0 && (wantsPool || !activeSnapshot || !isFreshTuiQuotaSnapshot(activeSnapshot, now))
		? await fetchTuiQuotaOverview({
			cachePath: join(dirname(getStoragePath()), TUI_QUOTA_OVERVIEW_CACHE_FILE),
			now, enabled: refresh.enabled, refreshIntervalMs: refresh.intervalMs,
			loadStorage: () => Promise.resolve(pool),
		})
		: undefined;
	const readings = accounts.map((account, index) => resolveAccountReading(account, index, rawOverview, snapshot));
	// Disabled accounts stay visible in the sidebar, but never contribute
	// headroom or reset-credit actions to the enabled pool's aggregate.
	const enabledReadings = readings.filter((reading, index): reading is TuiQuotaOverviewAccount =>
		reading !== undefined && accounts[index]?.enabled !== false);
	const overview: TuiQuotaOverviewSnapshot | undefined = rawOverview || enabledReadings.length > 0 ? {
		version: TUI_QUOTA_CACHE_VERSION,
		fetchedAt: enabledReadings.length > 0
			? Math.min(...enabledReadings.map((reading) => reading.fetchedAt ?? 0))
			: rawOverview?.fetchedAt ?? now,
		accounts: enabledReadings,
	} : undefined;
	const overviewAccounts = overview ? toQuotaOverviewAccounts(overview).map((row) => {
		const account = accounts[row.index - 1];
		return { ...row, shortName: resolveAccountShortName(account, row.index) };
	}) : [];
	const reading = readings[activeIndex];
	const quota: CompactQuotaStatus = active && reading ? {
		type: "ready", limits: reading.limits,
		stale: isStaleReading(reading, now, refresh.intervalMs),
		source: activeSnapshot?.fetchedAt === reading.fetchedAt ? activeSnapshot?.source : "usage",
		fetchedAt: reading.fetchedAt, fingerprint: reading.fingerprint,
		accountIndex: activeIndex + 1, accountCount: accounts.length,
		accountEmail: active.email, accountLabel: active.accountLabel,
		accountShortName: resolveAccountShortName(active, activeIndex + 1),
		planType: reading.planType,
	} : { type: accounts.length > 0 ? "unavailable" : "missing" };
	const prefix = status.prefix;
	const reservedChars = displayWidth(prefix);
	const activeText = formatPromptStatusText({
		quota, width, reservedChars, quotaDisplay, maskEmail, glyphMode,
		activeAccountName: status.activeAccountName,
		accountHint: active ? { index: activeIndex + 1, shortName: resolveAccountShortName(active, activeIndex + 1) } : undefined,
	});
	const renderScreen = (screen: (typeof status.screens)[number]): string => {
		if (screen === "active" || !overview) return activeText;
		const format = screen === "resets" ? formatQuotaResetsStatusLines
			: screen === "credits" ? formatQuotaCreditsStatusLines : formatQuotaOverviewStatusLines;
		return format({
			accounts: overviewAccounts, width, reservedChars, maxRows: status.rows,
			resetsMinUsedPercent: status.resetsMinUsedPercent,
			options: { ...status, names: status.accountNames, mode: quotaDisplay, maskEmail, now },
		}).join("\n");
	};
	const rendered = status.screens.map((screen) => ({ screen, text: renderScreen(screen) })).filter((entry) => entry.text.length > 0);
	const current = rendered.length > 0 ? rendered[Math.floor(now / status.rotateMs) % rendered.length] : undefined;
	const text = current ? withStatusPrefix(current.text.split("\n"), prefix).join("\n") : "";
	const poolStale = enabledReadings.some((row) => isStaleReading(row, now, refresh.intervalMs));
	const poolTone = current?.screen === "resets" || current?.screen === "credits"
		? poolStale ? "stale" as const : "warning" as const
		: resolveQuotaOverviewTone(overviewAccounts, poolStale);
	return {
		text, glyphMode, quotaDisplay,
		statusColor: status.color,
		statusTone: current?.screen === "active" || !overview ? resolveQuotaPromptTone(quota)
			: poolTone,
		sidebar: {
			enabled: sidebar.enabled, showQuota: sidebar.showQuota, showResetTimes: sidebar.showResetTimes,
			showFiveHour: sidebar.showFiveHour, color: sidebar.color,
		},
		accountStorage: getCurrentProjectRoot() ? "project" as const : "global" as const,
		accounts: accounts.map((account, index) => {
			const shortName = resolveAccountShortName(account, index + 1);
			const label = sanitizeDisplayText(maskEmailsInText(account.accountLabel ?? "", maskEmail)) ??
				sanitizeDisplayText(resolveDisplayEmail(account.email, maskEmail)) ?? `Account ${index + 1}`;
			const value = readings[index];
			return {
				index: index + 1, label, shortName,
				displayName: sidebar.accountNames === "short" ? `[${shortName}]`
					: sidebar.accountNames === "full" ? label : sidebar.accountNames === "number" ? `[A${index + 1}]` : "",
				active: index === activeIndex, enabled: account.enabled !== false,
				// OpenCode's JSON encoder rejects explicit undefined, even in optional fields.
				...(value && { quota: {
					// Explicit allowlist: do not send cache identity or read-error text.
					limits: value.limits.filter((limit) => isWeeklyQuotaWindow(limit) ||
						(sidebar.showFiveHour && isFiveHourQuotaWindow(limit))).map((limit) => ({
						label: sanitizeDisplayText(limit.label) ?? "quota",
						leftPercent: limit.leftPercent,
						...(limit.usedPercent !== undefined && { usedPercent: limit.usedPercent }),
						...(limit.windowMinutes !== undefined && { windowMinutes: limit.windowMinutes }),
						...(limit.resetAtMs !== undefined && { resetAtMs: limit.resetAtMs }),
					})),
					...(value.fetchedAt !== undefined && { fetchedAt: value.fetchedAt }),
					stale: isStaleReading(value, now, refresh.intervalMs),
					readFailed: value.readFailedAt !== undefined,
				} }),
			};
		}),
		details: formatQuotaDetailsText(quota, now, { quotaDisplay, maskEmail: getCodexTuiMaskEmailInQuotaDetails(config) }),
		showFor: status.showFor,
	};
}
