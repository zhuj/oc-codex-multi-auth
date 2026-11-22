import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { lock } from "proper-lockfile";

vi.mock("../lib/codex-usage.js", async (importActual) => {
	const actual = await importActual<typeof import("../lib/codex-usage.js")>();
	return { ...actual, ensureCodexUsageAccessToken: vi.fn() };
});

import { createUsageAccountFingerprint, ensureCodexUsageAccessToken } from "../lib/codex-usage.js";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";
import * as atomicWrite from "../lib/storage/atomic-write.js";
import * as quotaCache from "../lib/tui-quota-cache.js";
import { fetchTuiQuotaOverview, resetTuiQuotaOverviewThrottle } from "../lib/tui-quota-overview.js";

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const TEN_MINUTES = 600_000;
const DAY = 86_400_000;
const network = vi.fn<typeof fetch>();

function account(id: string, overrides: Partial<AccountMetadataV3> = {}): AccountMetadataV3 {
	return {
		accountId: `FAKE_ACCOUNT_${id}`,
		refreshToken: `FAKE_REFRESH_${id}`,
		accessToken: `FAKE_ACCESS_${id}`,
		enabled: true,
		addedAt: NOW,
		lastUsed: NOW,
		...overrides,
	};
}

function usageResponse(): Response {
	return Response.json({
		plan_type: "plus",
		rate_limit: {
			primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: (NOW + 3_600_000) / 1000 },
			secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_at: (NOW + DAY) / 1000 },
		},
	});
}

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("pool quota request budget", () => {
	let dir: string;
	let cachePath: string;
	let storage: AccountStorageV3;
	const loadStorage = vi.fn<() => Promise<AccountStorageV3 | null>>();

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "oc-quota-budget-"));
		cachePath = join(dir, "overview.json");
		storage = { version: 3, activeIndex: 0, accounts: [account("A")] };
		loadStorage.mockReset().mockImplementation(async () => storage);
		resetTuiQuotaOverviewThrottle();
		vi.mocked(ensureCodexUsageAccessToken).mockReset().mockResolvedValue({
			accessToken: "FAKE_ACCESS", refreshed: false, persisted: false,
		});
		network.mockReset().mockImplementation(async (url, init) => {
			expect(String(url)).toMatch(/\/wham\/usage$/);
			expect(init?.method).toBe("GET");
			return usageResponse();
		});
		vi.stubGlobal("fetch", network);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		resetTuiQuotaOverviewThrottle();
		await rm(dir, { recursive: true, force: true });
	});

	function read(now = NOW, options: { enabled?: boolean; refreshIntervalMs?: number } = {}) {
		return fetchTuiQuotaOverview({ cachePath, now, loadStorage, ...options });
	}

	async function seedCache(accounts = storage.accounts) {
		const snapshot: quotaCache.TuiQuotaOverviewSnapshot = {
			version: 1,
			fetchedAt: NOW - DAY,
			accounts: accounts.map((item, index) => ({
				fingerprint: createUsageAccountFingerprint(item),
				index: index + 1,
				fetchedAt: NOW - DAY,
				limits: [{ label: "5h", usedPercent: 70, leftPercent: 30, windowMinutes: 300 }],
			})),
		};
		await quotaCache.writeTuiQuotaOverviewSnapshot(snapshot, cachePath);
		return snapshot;
	}

	it("coalesces cold callers by resolved path, deduplicates enabled accounts, and caps concurrent GETs at two", async () => {
		storage.accounts = [
			account("A"), account("B"), account("A", { refreshToken: "FAKE_NEW_REFRESH_A" }),
			account("DISABLED", { enabled: false }), account("C"),
		];
		const firstBatch = deferred();
		const finish = deferred();
		let active = 0;
		let peak = 0;
		network.mockImplementation(async () => {
			active += 1;
			peak = Math.max(peak, active);
			if (active === 2) firstBatch.resolve();
			await finish.promise;
			active -= 1;
			return usageResponse();
		});
		const first = read();
		const second = fetchTuiQuotaOverview({ cachePath: relative(process.cwd(), cachePath), now: NOW, loadStorage });
		await firstBatch.promise;
		expect(network).toHaveBeenCalledTimes(2);
		finish.resolve();
		const [a, b] = await Promise.all([first, second]);
		expect(a).toBe(b);
		expect(a?.accounts.map((item) => item.index)).toEqual([2, 3, 5]);
		expect(network).toHaveBeenCalledTimes(3);
		expect(ensureCodexUsageAccessToken).toHaveBeenCalledTimes(3);
		expect(loadStorage).toHaveBeenCalledTimes(1);
		expect(peak).toBe(2);
	});

	it("budgets repeated calls for ten minutes even after the display cache turns stale", async () => {
		const first = await read();
		for (const elapsed of [1, 2_000, 300_000, TEN_MINUTES - 1]) {
			expect(await read(NOW + elapsed)).toEqual(first);
		}
		expect(network).toHaveBeenCalledTimes(1);
		await read(NOW + TEN_MINUTES);
		expect(network).toHaveBeenCalledTimes(2);
	});

	it.each([0, 1, 599_999, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"does not let refreshIntervalMs=%s bypass the ten-minute floor",
		async (refreshIntervalMs) => {
			await read(NOW, { refreshIntervalMs });
			await read(NOW + TEN_MINUTES - 1, { refreshIntervalMs });
			expect(network).toHaveBeenCalledTimes(1);
			await read(NOW + TEN_MINUTES, { refreshIntervalMs });
			expect(network).toHaveBeenCalledTimes(2);
		},
	);

	it.each([3_600_000, DAY * 2])("honors a longer interval with a one-day ceiling (%s)", async (refreshIntervalMs) => {
		const expected = Math.min(refreshIntervalMs, DAY);
		await read(NOW, { refreshIntervalMs });
		await read(NOW + expected - 1, { refreshIntervalMs });
		expect(network).toHaveBeenCalledTimes(1);
		await read(NOW + expected, { refreshIntervalMs });
		expect(network).toHaveBeenCalledTimes(2);
	});

	it("records failed GET attempts across memory resets so cold processes do not retry", async () => {
		network.mockImplementation(async () => Response.json({ error: { message: "Unavailable" } }, { status: 503 }));
		expect(await read()).toBeUndefined();
		await read(NOW + 2_000);
		resetTuiQuotaOverviewThrottle();
		await read(NOW + 300_000);
		await read(NOW + TEN_MINUTES - 1);
		expect(network).toHaveBeenCalledTimes(1);
		expect(ensureCodexUsageAccessToken).toHaveBeenCalledTimes(1);
		await read(NOW + TEN_MINUTES);
		expect(network).toHaveBeenCalledTimes(2);
	});

	it("budgets credential failures and keeps the prior reading without a usage GET", async () => {
		await seedCache();
		vi.mocked(ensureCodexUsageAccessToken).mockRejectedValue(new Error("OAuth temporarily unavailable"));
		const first = await read();
		await read(NOW + 2_000);
		resetTuiQuotaOverviewThrottle();
		expect(await read(NOW + 300_000)).toEqual(first);
		expect(ensureCodexUsageAccessToken).toHaveBeenCalledTimes(1);
		expect(network).not.toHaveBeenCalled();
	});

	it("reads cache only when disabled, including a cold start and expired cache", async () => {
		expect(await read(NOW, { enabled: false })).toBeUndefined();
		const cached = await seedCache();
		expect(await read(NOW + DAY, { enabled: false })).toEqual(cached);
		expect(loadStorage).not.toHaveBeenCalled();
		expect(ensureCodexUsageAccessToken).not.toHaveBeenCalled();
		expect(network).not.toHaveBeenCalled();
		await expect(readFile(`${cachePath}.attempt.json`)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("returns cached data immediately for a disabled reader during another caller's pending sweep", async () => {
		const cached = await seedCache();
		const entered = deferred();
		const finish = deferred();
		network.mockImplementation(async () => {
			entered.resolve();
			await finish.promise;
			return usageResponse();
		});
		const pending = read();
		await entered.promise;
		expect(await read(NOW, { enabled: false })).toEqual(cached);
		expect(network).toHaveBeenCalledTimes(1);
		finish.resolve();
		await pending;
	});

	it("keeps the newer in-memory result and request budget after a cache write fails", async () => {
		const cached = await seedCache();
		vi.spyOn(quotaCache, "writeTuiQuotaOverviewSnapshot").mockRejectedValue(new Error("FAKE disk failure"));
		const first = await read();
		expect(first?.accounts[0]?.limits[0]?.leftPercent).toBe(75);
		expect(await quotaCache.readTuiQuotaOverviewSnapshot(cachePath)).toEqual(cached);
		expect(await read(NOW + 300_000)).toBe(first);
		expect(await read(NOW + DAY, { enabled: false })).toBe(first);
		resetTuiQuotaOverviewThrottle();
		expect(await read(NOW + TEN_MINUTES - 1)).toEqual(cached);
		expect(network).toHaveBeenCalledTimes(1);
	});

	it("persists a credential-free reservation before any credential or usage request", async () => {
		vi.mocked(ensureCodexUsageAccessToken).mockImplementation(async () => {
			const reservation: unknown = JSON.parse(await readFile(`${cachePath}.attempt.json`, "utf-8"));
			expect(reservation).toEqual({ version: 1, attemptedAt: NOW });
			return { accessToken: "FAKE_ACCESS", refreshed: false, persisted: false };
		});
		await read();
		expect(network).toHaveBeenCalledTimes(1);
	});

	it("serves cache without waiting or fetching when another process holds the reservation lock", async () => {
		const cached = await seedCache();
		const release = await lock(`${cachePath}.attempt.json`, { realpath: false, retries: 0 });
		try {
			expect(await read()).toEqual(cached);
			expect(network).not.toHaveBeenCalled();
			expect(ensureCodexUsageAccessToken).not.toHaveBeenCalled();
		} finally {
			await release();
		}
	});

	it("keeps a second process cache-only at interval expiry while the first sweep is still pending", async () => {
		const cached = await seedCache();
		const entered = deferred();
		const finish = deferred();
		network.mockImplementation(async () => {
			entered.resolve();
			await finish.promise;
			return usageResponse();
		});
		const first = read();
		await entered.promise;
		// Remove all in-process knowledge. Only the shared filesystem lease
		// can protect against this independent caller after the timestamp expires.
		resetTuiQuotaOverviewThrottle();
		try {
			expect(await read(NOW + TEN_MINUTES)).toEqual(cached);
			expect(network).toHaveBeenCalledTimes(1);
			expect(ensureCodexUsageAccessToken).toHaveBeenCalledTimes(1);
		} finally {
			finish.resolve();
			await first;
		}
	});

	it("fails closed on a corrupt reservation instead of creating a fresh network budget", async () => {
		const cached = await seedCache();
		await writeFile(`${cachePath}.attempt.json`, "{ invalid");
		expect(await read()).toEqual(cached);
		expect(network).not.toHaveBeenCalled();
		expect(ensureCodexUsageAccessToken).not.toHaveBeenCalled();
	});

	it("fails closed and backs off if the attempt cannot be persisted", async () => {
		const cached = await seedCache();
		const writeAttempt = vi.spyOn(atomicWrite, "writeFileAtomic").mockRejectedValue(new Error("FAKE write error"));
		expect(await read()).toEqual(cached);
		expect(await read(NOW + 2_000)).toEqual(cached);
		expect(writeAttempt).toHaveBeenCalledTimes(1);
		expect(network).not.toHaveBeenCalled();
		expect(ensureCodexUsageAccessToken).not.toHaveBeenCalled();
	});

	it("preserves disabled rows by current identity without fetching them or aging enabled readings", async () => {
		const disabled = account("DISABLED", { enabled: false, accountLabel: "Renamed" });
		await seedCache([disabled, account("REMOVED")]);
		storage.accounts.push(disabled);
		const result = await read();
		expect(network).toHaveBeenCalledTimes(1);
		expect(ensureCodexUsageAccessToken).toHaveBeenCalledTimes(1);
		expect(result?.fetchedAt).toBe(NOW);
		expect(result?.accounts).toHaveLength(2);
		expect(result?.accounts[1]).toMatchObject({
			fingerprint: createUsageAccountFingerprint(disabled), index: 2, label: "Renamed", fetchedAt: NOW - DAY,
		});
	});

	it("dates a failed enabled reading independently of an older disabled row", async () => {
		const enabled = account("A");
		const disabled = account("DISABLED", { enabled: false });
		storage.accounts = [enabled, disabled];
		const cached = await seedCache();
		const reading = cached.accounts[0];
		if (!reading) throw new Error("Missing enabled fixture reading");
		reading.fetchedAt = NOW - 3_600_000;
		await quotaCache.writeTuiQuotaOverviewSnapshot(cached, cachePath);
		network.mockImplementation(async () => Response.json({}, { status: 503 }));
		const result = await read();
		expect(result?.fetchedAt).toBe(NOW - 3_600_000);
		expect(result?.accounts[1]?.fetchedAt).toBe(NOW - DAY);
		expect(network).toHaveBeenCalledTimes(1);
	});
});
