/** Cross-process request budget for the optional pool quota display. */

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { lock } from "proper-lockfile";
import { logDebug } from "./logger.js";
import { writeFileAtomic } from "./storage/atomic-write.js";

const MIN_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const MAX_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface TuiQuotaOverviewLease {
	isValid(): boolean;
	release(): Promise<void>;
}

export function normalizeTuiQuotaOverviewRefreshInterval(interval?: number): number {
	return typeof interval === "number" && Number.isFinite(interval)
		? Math.min(MAX_REFRESH_INTERVAL_MS, Math.max(MIN_REFRESH_INTERVAL_MS, interval))
		: MIN_REFRESH_INTERVAL_MS;
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function readAttemptTime(path: string): Promise<number | undefined> {
	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch (error) {
		if (hasErrorCode(error, "ENOENT")) return undefined;
		throw error;
	}
	const value: unknown = JSON.parse(raw);
	if (
		typeof value !== "object" || value === null ||
		!("version" in value) || value.version !== 1 ||
		!("attemptedAt" in value) || typeof value.attemptedAt !== "number" ||
		!Number.isFinite(value.attemptedAt) || value.attemptedAt < 0
	) {
		throw new Error("Invalid pool quota attempt record");
	}
	return value.attemptedAt;
}

/**
 * Reserve one sweep before any token refresh or usage request. The sidecar is
 * deliberately separate from the readings: failed requests and failed cache
 * writes consume the same budget as successful ones. It contains no account
 * identifiers or credentials.
 *
 * Lock contention never waits for a network sweep. A contender uses its cache;
 * the winner holds this dedicated lease until the whole sweep finishes, so a
 * slow pool cannot overlap a second sweep after its refresh interval expires.
 * This lease never blocks account-storage writes or OAuth's separate lease.
 * Unreadable/unwritable coordination state fails closed instead of letting every
 * OpenCode process retry independently.
 */
export async function claimTuiQuotaOverviewAttempt(params: {
	cachePath: string;
	now: number;
	refreshIntervalMs: number;
}): Promise<{ lease?: TuiQuotaOverviewLease; attemptedAt: number }> {
	const path = `${params.cachePath}.attempt.json`;
	let release: (() => Promise<void>) | undefined;
	let compromised = false;
	let lease: TuiQuotaOverviewLease | undefined;
	// A local backoff also bounds repeated filesystem failures/lock contention.
	let attemptedAt = params.now;
	try {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		release = await lock(path, {
			realpath: false,
			retries: 0,
			stale: 10_000,
			update: 2_000,
			onCompromised: () => { compromised = true; },
		});
		const previous = await readAttemptTime(path);
		if (previous !== undefined && params.now - previous < params.refreshIntervalMs) {
			attemptedAt = previous;
		} else if (!compromised) {
			await writeFileAtomic(path, JSON.stringify({ version: 1, attemptedAt: params.now }));
			if (!compromised) {
				const releaseLease = release;
				lease = {
					isValid: () => !compromised,
					release: async () => {
						try {
							await releaseLease();
						} catch {
							logDebug("Could not release the pool quota request lease");
						}
					},
				};
				// Ownership passes to the sweep; the finally block below releases
				// only rejected/failed reservations.
				release = undefined;
			}
		}
	} catch {
		logDebug("Using cached pool quota because its shared request budget is unavailable");
	} finally {
		if (release) {
			try {
				await release();
			} catch {
				logDebug("Could not release the pool quota request lease");
			}
		}
	}
	return { lease, attemptedAt };
}
