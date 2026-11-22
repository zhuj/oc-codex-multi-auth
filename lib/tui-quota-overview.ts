/**
 * Gather every account's quota for the pool-wide status line.
 *
 * The single-account status the request path maintains cannot answer "where
 * does the pool stand" - it only ever describes the account that served the
 * last response. This reads `/wham/usage` for each distinct account instead,
 * on a bounded interval, and caches the result where every OpenCode window on
 * the machine can share it.
 *
 * The cache is what keeps this cheap. A reader takes a snapshot that is still
 * fresh rather than issuing its own requests, so N terminals open on the same
 * pool cost one round of requests between them rather than N, and a terminal
 * that has just started renders immediately instead of showing nothing while
 * seven accounts are queried one after another.
 */

import { resolve } from "node:path";
import {
	createUsageAccountFingerprint,
	deduplicateUsageAccountIndices,
	ensureCodexUsageAccessToken,
	fetchCodexUsage,
	getUsageLeftPercent,
	isCodexCredentialFailure,
	hasUsageWindow,
	parseCodexUsagePayload,
	resolveCodexUsageAccountId,
	summarizeCodexErrorMessage,
	type CodexUsageSummary,
	type LimitWindow,
} from "./codex-usage.js";
import { creditsLedger, getCreditsAccountKey, hasSpendableCredits } from "./codex-credits.js";
import { logDebug, maskString } from "./logger.js";
import type { QuotaOverviewAccount } from "./quota-overview.js";
import { loadAccounts, type AccountStorageV3 } from "./storage.js";
import {
	getTuiQuotaOverviewCachePath,
	readTuiQuotaOverviewSnapshot,
	writeTuiQuotaOverviewSnapshot,
	TUI_QUOTA_CACHE_VERSION,
	type TuiQuotaOverviewAccount,
	type TuiQuotaOverviewSnapshot,
	type TuiQuotaSnapshot,
} from "./tui-quota-cache.js";
import {
	claimTuiQuotaOverviewAttempt,
	normalizeTuiQuotaOverviewRefreshInterval,
	type TuiQuotaOverviewLease,
} from "./tui-quota-throttle.js";

/**
 * Accounts queried at once. Matches the quota monitor's own limit: this talks
 * to the same endpoint with the same credentials, and a pool of a dozen seats
 * should not arrive as a dozen simultaneous requests.
 */
const MAX_CONCURRENCY = 2;

interface OverviewThrottleState {
	attemptedAt?: number;
	snapshot?: TuiQuotaOverviewSnapshot;
	pending?: Promise<TuiQuotaOverviewSnapshot | undefined>;
}

const overviewThrottle = new Map<string, OverviewThrottleState>();

/** Test hook: the on-disk attempt budget intentionally survives a process reset. */
export function resetTuiQuotaOverviewThrottle(): void {
	overviewThrottle.clear();
}

function latestSnapshotChange(snapshot: TuiQuotaOverviewSnapshot): number {
	return snapshot.accounts.reduce(
		(latest, account) => Math.max(latest, account.fetchedAt ?? 0, account.readFailedAt ?? 0),
		snapshot.fetchedAt,
	);
}

async function readCachedOverview(
	cachePath: string,
	state: OverviewThrottleState,
): Promise<TuiQuotaOverviewSnapshot | undefined> {
	const cached = await readTuiQuotaOverviewSnapshot(cachePath);
	if (cached && (!state.snapshot || latestSnapshotChange(cached) > latestSnapshotChange(state.snapshot))) {
		state.snapshot = cached;
	}
	// A failed write must not replace this process's newer reading with the
	// older file. On equal timestamps, keep the last in-memory result.
	return state.snapshot;
}

interface FetchTuiQuotaOverviewParams {
	cachePath?: string;
	now?: number;
	loadStorage?: () => Promise<AccountStorageV3 | null>;
	enabled?: boolean;
	refreshIntervalMs?: number;
}

function toOverviewLimit(window: LimitWindow, label: string) {
	return {
		label,
		leftPercent: getUsageLeftPercent(window.usedPercent) ?? null,
		usedPercent: window.usedPercent,
		windowMinutes: window.windowMinutes,
		resetAtMs: window.resetAtMs,
	};
}

/**
 * Reduce one account's usage document to what the status line needs.
 *
 * Only the primary and secondary windows are kept. Code-review and the other
 * additional quotas do not govern ordinary model requests, so counting them
 * would let a spent code-review allowance report an account as unusable for
 * work it can still do.
 */
export function toOverviewAccount(params: {
	fingerprint: string;
	index: number;
	usage: CodexUsageSummary;
	email?: string;
	label?: string;
}): TuiQuotaOverviewAccount {
	const limits = [
		{ window: params.usage.primary, label: "5h" },
		{ window: params.usage.secondary, label: "weekly" },
	]
		.filter(({ window }) => hasUsageWindow(window))
		.map(({ window, label }) => toOverviewLimit(window, label));
	const resetCredits = params.usage.resetCredits;
	return {
		fingerprint: params.fingerprint,
		index: params.index,
		email: params.email?.trim() || undefined,
		// Only a label the user set, never the accountId/organizationId
		// fallbacks other surfaces use: those identify an account without
		// naming it, and a 36-character UUID on a status line names nothing.
		label: params.label?.trim() || undefined,
		planType: params.usage.planType ?? undefined,
		// `applicableNow` is the count that can be redeemed against a window
		// that is actually spent, which is the only one worth showing beside a
		// percentage. It falls back to the banked total only when the server
		// stated a count this build could not read.
		resetCredits:
			resetCredits?.applicableNow ?? resetCredits?.available ?? undefined,
		resetCreditsApplicable: resetCredits?.applicableNow ?? null,
		// Kept only when there is something to spend, so a snapshot of
		// subscription accounts does not carry a zero balance per account.
		...(hasSpendableCredits(params.usage.creditsBalance)
			? { credits: params.usage.creditsBalance ?? undefined }
			: {}),
		limits,
	};
}

type OverviewFetchResult =
	| { reading: TuiQuotaOverviewAccount }
	| { error: string; credential: boolean };

async function fetchOverviewAccount(
	storage: AccountStorageV3,
	index: number,
	lease: TuiQuotaOverviewLease,
): Promise<OverviewFetchResult | undefined> {
	const account = storage.accounts[index];
	if (!account || !lease.isValid()) return undefined;
	try {
		const credentials = await ensureCodexUsageAccessToken({ storage, account });
		if (!lease.isValid()) return undefined;
		const accountId = resolveCodexUsageAccountId({
			account,
			accessToken: credentials.accessToken,
		});
		if (!accountId) {
			return { error: "could not resolve account id (re-login may be required)", credential: true };
		}
		const usage = parseCodexUsagePayload(
			await fetchCodexUsage({
				accountId,
				accessToken: credentials.accessToken,
				organizationId: account.organizationId,
				normalizeAccountErrors: true,
			}),
		);
		creditsLedger.record(getCreditsAccountKey(account), usage.creditsBalance);
		return {
			reading: toOverviewAccount({
				fingerprint: createUsageAccountFingerprint(account),
				index: index + 1,
				usage,
				email: account.email,
				label: account.accountLabel,
			}),
		};
	} catch (error) {
		// The refresh endpoint's error body can echo token material, so the
		// reason is masked before it is written to a shared cache file.
		const message = maskString(
			summarizeCodexErrorMessage(error instanceof Error ? error.message : String(error)),
		);
		logDebug(`Failed to fetch pool quota for one account: ${message}`);
		return { error: message, credential: isCodexCredentialFailure(error) };
	}
}

export function fetchTuiQuotaOverview(
	params: FetchTuiQuotaOverviewParams,
): Promise<TuiQuotaOverviewSnapshot | undefined> {
	const cachePath = resolve(params.cachePath ?? getTuiQuotaOverviewCachePath());
	let state = overviewThrottle.get(cachePath);
	if (!state) {
		state = {};
		overviewThrottle.set(cachePath, state);
	}
	if (params.enabled === false) return readCachedOverview(cachePath, state);
	if (state.pending) return state.pending;
	const current = state;
	// Install the promise before the first cache read resolves. Otherwise two
	// cold callers could both enter the sweep before either records an attempt.
	const pending = refreshTuiQuotaOverview(params, cachePath, current)
		.then((snapshot) => {
			current.snapshot = snapshot;
			return snapshot;
		})
		.finally(() => {
			if (current.pending === pending) current.pending = undefined;
		});
	current.pending = pending;
	return pending;
}

async function refreshTuiQuotaOverview(
	params: FetchTuiQuotaOverviewParams,
	cachePath: string,
	state: OverviewThrottleState,
): Promise<TuiQuotaOverviewSnapshot | undefined> {
	const now = params.now ?? Date.now();
	const refreshIntervalMs = normalizeTuiQuotaOverviewRefreshInterval(params.refreshIntervalMs);
	const cached = await readCachedOverview(cachePath, state);
	if (
		(state.attemptedAt !== undefined && now - state.attemptedAt < refreshIntervalMs) ||
		(cached && now - cached.fetchedAt < refreshIntervalMs)
	) return cached;

	const reservation = await claimTuiQuotaOverviewAttempt({ cachePath, now, refreshIntervalMs });
	state.attemptedAt = reservation.attemptedAt;
	if (!reservation.lease) return cached;
	try {
		return await fetchFreshOverview({ ...params, cachePath, now, cached, lease: reservation.lease });
	} finally {
		await reservation.lease.release();
	}
}

async function fetchFreshOverview(params: {
	cachePath: string;
	now: number;
	cached: TuiQuotaOverviewSnapshot | undefined;
	loadStorage?: () => Promise<AccountStorageV3 | null>;
	lease: TuiQuotaOverviewLease;
}): Promise<TuiQuotaOverviewSnapshot | undefined> {
	const { now, cached, cachePath, lease } = params;
	let storage: AccountStorageV3 | null;
	try {
		storage = await (params.loadStorage ?? loadAccounts)();
	} catch {
		logDebug("Using cached pool quota because account storage could not be read");
		return cached;
	}
	if (!storage || storage.accounts.length === 0) return undefined;

	const indices = deduplicateUsageAccountIndices(storage);
	const accounts: TuiQuotaOverviewAccount[] = [];
	// Date the enabled pool by its oldest carried reading. Disabled rows keep
	// their own timestamps for the sidebar without aging the pool summary.
	let oldestEnabledReading = now;
	for (let offset = 0; offset < indices.length; offset += MAX_CONCURRENCY) {
		const chunk = indices.slice(offset, offset + MAX_CONCURRENCY);
		const results = await Promise.all(
			chunk.map((index) => fetchOverviewAccount(storage, index, lease)),
		);
		for (const [position, result] of results.entries()) {
			if (result && "reading" in result) {
				accounts.push({ ...result.reading, fetchedAt: now });
				continue;
			}
			// A failed fetch must not drop the account out of the snapshot: the
			// pool would be judged on a subset, and one transient error on the
			// only account with headroom would flip the line to "fully spent"
			// and surface the resets screen wrongly. The cached reading is reused
			// only for the SAME account - same pool position and same credential
			// fingerprint, so a pool that changed membership never inherits a
			// stranger's numbers - and the snapshot below keeps the older fetch
			// time so the reading is rendered stale rather than current.
			const index = chunk[position];
			const account =
				index === undefined ? undefined : storage.accounts[index];
			const previous =
				index === undefined || account === undefined
					? undefined
					: cached?.accounts.find(
							(candidate) =>
								candidate.index === index + 1 &&
								candidate.fingerprint ===
									createUsageAccountFingerprint(account),
						);
			if (previous) {
				// Only dead credentials mark the reading as describing an account
				// that cannot serve requests. A transient failure keeps whatever
				// an earlier poll concluded; the older `fetchedAt` already dates it.
				accounts.push({
					...previous,
					fetchedAt: previous.fetchedAt ?? cached?.fetchedAt,
					...(result && "credential" in result && result.credential
						? {
							readFailedAt: now,
							readFailedSince: previous.readFailedSince ?? previous.readFailedAt ?? now,
							readError: result.error,
						}
						: {}),
				});
				oldestEnabledReading = Math.min(oldestEnabledReading, previous.fetchedAt ?? cached?.fetchedAt ?? now);
			}
		}
	}
	// Disabled accounts are never queried, but a sidebar can still show their
	// last known reading. Match identity rather than old pool position, and do
	// not let those rows age the enabled pool's successful refresh timestamp.
	for (const [index, account] of storage.accounts.entries()) {
		if (account.enabled !== false) continue;
		const fingerprint = createUsageAccountFingerprint(account);
		const previous = cached?.accounts.find((candidate) => candidate.fingerprint === fingerprint);
		if (previous) {
			accounts.push({
				...previous,
				index: index + 1,
				email: account.email?.trim() || undefined,
				label: account.accountLabel?.trim() || undefined,
				fetchedAt: previous.fetchedAt ?? cached?.fetchedAt,
			});
		}
	}
	// Every account failing means the pool was not observed at all, which is a
	// different statement from "the pool is empty". Keeping the previous
	// snapshot lets the line stay on the last thing known to be true rather
	// than blanking on one bad network moment.
	if (accounts.length === 0) return cached;

	accounts.sort((left, right) => left.index - right.index);
	const snapshot: TuiQuotaOverviewSnapshot = {
		version: TUI_QUOTA_CACHE_VERSION,
		// A snapshot carrying a reused reading is only as fresh as that
		// reading, so it keeps the previous fetch time - the stale flag is how
		// the line says "part of this is not new" without dropping it.
		fetchedAt: oldestEnabledReading,
		accounts,
	};
	try {
		await writeTuiQuotaOverviewSnapshot(snapshot, cachePath);
	} catch (error) {
		logDebug(
			`Failed to cache the pool quota snapshot: ${(error as Error).message}`,
		);
	}
	return snapshot;
}

/**
 * Fold the request path's live reading of one account into the polled pool.
 *
 * The pool is re-read on an interval, but the account currently serving
 * requests has its quota pushed from response headers after every single
 * response. Without this the line would show that account's numbers as they
 * were at the last poll while the user watches their own requests spend
 * it - the one account whose figure a reader can check against their own
 * activity would be the one that looks wrong.
 *
 * Only a snapshot NEWER than the poll is merged, so a header reading left over
 * from before the poll cannot overwrite it with older numbers.
 */
export function mergeOverviewWithLatestAccount(
	snapshot: TuiQuotaOverviewSnapshot,
	latest: TuiQuotaSnapshot | undefined,
): TuiQuotaOverviewSnapshot {
	if (!latest || latest.fetchedAt <= snapshot.fetchedAt) return snapshot;
	if (latest.limits.length === 0) return snapshot;
	let merged = false;
	const accounts = snapshot.accounts.map((account) => {
		if (account.fingerprint !== latest.fingerprint) return account;
		// The snapshot's own time is its oldest reading, so the account's own
		// time is what the header reading has to beat.
		if (account.fetchedAt !== undefined && latest.fetchedAt <= account.fetchedAt) {
			return account;
		}
		merged = true;
		// A response that came back after the latest failed poll proves the
		// account works again. One from before it proves nothing about it.
		const recovered =
			account.readFailedAt === undefined || latest.fetchedAt > account.readFailedAt;
		return {
			...account,
			planType: latest.planType ?? account.planType,
			email: account.email ?? (latest.accountEmail?.trim() || undefined),
			limits: latest.limits,
			fetchedAt: latest.fetchedAt,
			...(recovered
				? { readFailedAt: undefined, readFailedSince: undefined, readError: undefined }
				: {}),
		};
	});
	return merged ? { ...snapshot, accounts } : snapshot;
}

export function toQuotaOverviewAccounts(
	snapshot: TuiQuotaOverviewSnapshot,
): QuotaOverviewAccount[] {
	return snapshot.accounts.map((account) => ({
		index: account.index,
		email: account.email,
		label: account.label,
		planType: account.planType,
		resetCredits: account.resetCredits,
		resetCreditsApplicable: account.resetCreditsApplicable,
		credits: account.credits,
		windows: account.limits.map((limit) => ({
			leftPercent: limit.leftPercent ?? undefined,
			exactLeftPercent: typeof limit.usedPercent === "number" && Number.isFinite(limit.usedPercent)
				? Math.max(0, Math.min(100, 100 - limit.usedPercent)) : undefined,
			resetAtMs: limit.resetAtMs,
		})),
	}));
}
