import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountMetadataV3, AccountStorageV3 } from "../lib/storage.js";
import type { PluginConfig } from "../lib/types.js";

const mocks = vi.hoisted(() => ({
	config: {} as PluginConfig,
	pool: null as AccountStorageV3 | null,
	storagePath: "",
}));

vi.mock("../lib/config.js", async (original) => ({
	...await original<typeof import("../lib/config.js")>(),
	// Deliberately return the same mutable object: presentation changes must
	// be observed without creating a new identity that could reset the budget.
	loadPluginConfig: () => mocks.config,
}));
vi.mock("../lib/storage.js", async (original) => ({
	...await original<typeof import("../lib/storage.js")>(),
	getStoragePath: () => mocks.storagePath,
	loadAccounts: async () => mocks.pool,
}));
vi.mock("../lib/storage/state.js", async (original) => ({
	...await original<typeof import("../lib/storage/state.js")>(),
	getCurrentProjectRoot: () => null,
}));
vi.mock("../lib/codex-usage.js", async (original) => ({
	...await original<typeof import("../lib/codex-usage.js")>(),
	// Keep the real HTTP usage client, parser and fingerprinting. Only OAuth
	// acquisition is replaced, so no credential files or refresh calls exist.
	ensureCodexUsageAccessToken: vi.fn(),
}));

import { createUsageAccountFingerprint, ensureCodexUsageAccessToken } from "../lib/codex-usage.js";
import { readV2Status, resetV2StatusThrottle } from "../lib/opencode-v2-status.js";
import { formatTuiAccountSidebar } from "../lib/tui-account-sidebar.js";
import {
	TUI_QUOTA_CACHE_VERSION,
	TUI_QUOTA_OVERVIEW_CACHE_FILE,
	writeTuiQuotaOverviewSnapshot,
	writeTuiQuotaSnapshot,
} from "../lib/tui-quota-cache.js";

const NOW = Date.UTC(2026, 10, 22, 12);
const INTERVAL = 10 * 60_000;
const ENABLED_IDS = ["FAKE_ACCOUNT_A", "FAKE_ACCOUNT_B", "FAKE_ACCOUNT_C"];
let directory = "";
let responseStatus = 200;
let inFlight = 0;
let maxInFlight = 0;
let fetchMock = vi.fn<typeof fetch>();

function account(id: string, enabled = true): AccountMetadataV3 {
	return {
		accountId: id, accountLabel: `Label ${id.at(-1)}`, refreshToken: `FAKE_REFRESH_${id}`,
		enabled, addedAt: NOW, lastUsed: NOW,
	};
}

function overviewPath(): string {
	return join(directory, TUI_QUOTA_OVERVIEW_CACHE_FILE);
}

function usagePayload() {
	return {
		plan_type: "plus",
		rate_limit: {
			primary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_at: (NOW + 5 * 60_000) / 1000 },
			secondary_window: { used_percent: 70, limit_window_seconds: 604_800, reset_at: (NOW + 2 * 86_400_000) / 1000 },
		},
	};
}

function requestedAccountIds(): Array<string | null> {
	return fetchMock.mock.calls.map(([, options]) => new Headers(options?.headers).get("chatgpt-account-id"));
}

async function readMany(count = 12, width = 100) {
	return Promise.all(Array.from({ length: count }, () => readV2Status({ width })));
}

beforeEach(async () => {
	// Leave actual timers/filesystem scheduling alone: only wall time changes
	// between phases, and real HTTP calls still terminate at our fetch mock.
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	directory = await mkdtemp(join(tmpdir(), "oc-v2-status-budget-"));
	mocks.storagePath = join(directory, "accounts.json");
	vi.stubEnv("OPENCODE_STATE_DIR", directory);
	mocks.config = {
		quotaStatus: { mode: "active", activeAccountName: "short", color: "auto" },
		quotaSidebar: { enabled: true, accountNames: "short", showQuota: true, showResetTimes: true, color: "default" },
		quotaRefresh: { enabled: true, intervalMs: INTERVAL },
	};
	mocks.pool = {
		version: 3, activeIndex: 0,
		accounts: [
			...ENABLED_IDS.map((id) => id === "FAKE_ACCOUNT_A" ? { ...account(id), shortName: "work" } : account(id)),
			account("FAKE_ACCOUNT_DISABLED", false),
			// Repeated stored entries for one quota must not multiply GETs.
			account("FAKE_ACCOUNT_B"),
		],
	};
	resetV2StatusThrottle();
	vi.mocked(ensureCodexUsageAccessToken).mockReset().mockResolvedValue({
		accessToken: "FAKE_ACCESS_TOKEN", refreshed: false, persisted: false,
	});
	responseStatus = 200;
	inFlight = 0;
	maxInFlight = 0;
	fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
		inFlight += 1;
		maxInFlight = Math.max(maxInFlight, inFlight);
		try {
			// A real scheduling boundary exposes accidental serial or unbounded
			// batches while keeping every request inside this isolated fixture.
			await new Promise<void>((resolve) => setImmediate(resolve));
			return new Response(JSON.stringify(responseStatus === 200 ? usagePayload() : { error: "FAKE_USAGE_UNAVAILABLE" }), {
				status: responseStatus, headers: { "content-type": "application/json" },
			});
		} finally {
			inFlight -= 1;
		}
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
	resetV2StatusThrottle();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	if (directory) await rm(directory, { recursive: true, force: true });
});

describe("V2 status service request budget", () => {
	it("shares one bounded sweep across RPCs and live display changes, then refreshes at the interval", async () => {
		const initial = await readMany(24);
		expect(fetchMock).toHaveBeenCalledTimes(ENABLED_IDS.length);
		expect(requestedAccountIds().sort()).toEqual([...ENABLED_IDS].sort());
		expect(ensureCodexUsageAccessToken).toHaveBeenCalledTimes(ENABLED_IDS.length);
		expect(maxInFlight).toBe(2);
		for (const [url, options] of fetchMock.mock.calls) {
			expect(String(url)).toMatch(/\/wham\/usage$/);
			expect(options?.method).toBe("GET");
		}
		expect(initial[0]?.text).toContain("[work]");
		expect(initial[0]?.accounts).toHaveLength(5);
		expect(initial[0]?.accounts[3]?.enabled).toBe(false);
		expect(initial[0]?.accounts[3]).not.toHaveProperty("quota");
		expect(initial.every((result) => result.accounts[0]?.quota?.limits.map(({ leftPercent }) => leftPercent).join() === "30")).toBe(true);
		const initialSidebar = formatTuiAccountSidebar(initial[0]!.accounts, { showQuota: true, showResetTimes: true, now: NOW });
		expect(initialSidebar).toContain("(7d: 30% in 2d)");

		const sameConfig = mocks.config;
		const active = mocks.pool?.accounts[0];
		if (!active) throw new Error("Missing active account fixture");
		active.shortName = "studio";
		mocks.config.quotaStatus!.color = "#12Ab34";
		mocks.config.quotaSidebar!.color = "accent";
		mocks.config.quotaSidebar!.showFiveHour = true;
		mocks.config.quotaDisplay = "used";
		// Even an inadmissibly short interval cannot bypass the minimum budget.
		mocks.config.quotaRefresh!.intervalMs = 1;
		vi.setSystemTime(NOW + 2 * 60_000);
		const changed = await readMany(16, 120);
		expect(mocks.config).toBe(sameConfig);
		expect(changed[0]).toMatchObject({ statusColor: "#12Ab34", quotaDisplay: "used", sidebar: { color: "accent" } });
		expect(changed[0]?.text).toContain("[studio]");
		expect(changed[0]?.accounts[0]).toMatchObject({ displayName: "[studio]", quota: { fetchedAt: NOW } });
		expect(formatTuiAccountSidebar(changed[0]!.accounts, { showQuota: true, showResetTimes: true, quotaDisplay: "used", now: Date.now() }))
			.toContain("(5h: 40% used in 3m)");
		vi.setSystemTime(NOW + INTERVAL - 1);
		await readMany(8, 45);
		expect(fetchMock).toHaveBeenCalledTimes(ENABLED_IDS.length);

		vi.setSystemTime(NOW + INTERVAL);
		const refreshed = await readMany(24, 90);
		expect(fetchMock).toHaveBeenCalledTimes(2 * ENABLED_IDS.length);
		expect(requestedAccountIds().slice(ENABLED_IDS.length).sort()).toEqual([...ENABLED_IDS].sort());
		expect(maxInFlight).toBe(2);
		expect(refreshed[0]?.accounts[0]?.quota?.fetchedAt).toBe(NOW + INTERVAL);
		expect(JSON.stringify(refreshed[0])).not.toMatch(/FAKE_REFRESH|FAKE_ACCESS_TOKEN|FAKE_ACCOUNT_/);
	});

	it("budgets failed cold reads across repeat RPCs, display toggles and a reset of in-memory state", async () => {
		responseStatus = 503;
		const unavailable = await readMany(18);
		expect(fetchMock).toHaveBeenCalledTimes(ENABLED_IDS.length);
		expect(unavailable.every((result) => result.accounts.every((row) => row.quota === undefined))).toBe(true);
		expect(JSON.parse(await readFile(`${overviewPath()}.attempt.json`, "utf8"))).toMatchObject({ attemptedAt: NOW });
		vi.setSystemTime(NOW + 60_000);
		mocks.config.quotaRefresh!.enabled = false;
		await readMany();
		mocks.config.quotaRefresh!.enabled = true;
		mocks.config.quotaStatus!.color = "error";
		mocks.config.quotaSidebar!.showQuota = false;
		// Reset-only display still needs quota data but must keep the same budget.
		mocks.config.quotaSidebar!.showResetTimes = true;
		resetV2StatusThrottle();
		await readMany(18, 60);
		expect(fetchMock).toHaveBeenCalledTimes(ENABLED_IDS.length);
		expect(ensureCodexUsageAccessToken).toHaveBeenCalledTimes(ENABLED_IDS.length);

		responseStatus = 200;
		vi.setSystemTime(NOW + INTERVAL);
		const recovered = await readMany(18);
		expect(fetchMock).toHaveBeenCalledTimes(2 * ENABLED_IDS.length);
		expect(recovered[0]?.accounts[0]?.quota).toMatchObject({ stale: false, fetchedAt: NOW + INTERVAL });
		expect(maxInFlight).toBeLessThanOrEqual(2);
	});

	it("keeps cache-only mode at zero provider calls with missing or stale data, including disabled accounts", async () => {
		mocks.config.quotaRefresh!.enabled = false;
		const missing = await readMany();
		expect(missing[0]?.accounts.every((row) => row.quota === undefined)).toBe(true);
		await writeTuiQuotaOverviewSnapshot({
			version: TUI_QUOTA_CACHE_VERSION, fetchedAt: NOW - INTERVAL,
			accounts: mocks.pool!.accounts.map((row, index) => ({
				fingerprint: createUsageAccountFingerprint(row), index: index + 1, fetchedAt: NOW - INTERVAL,
				limits: [{ label: "weekly", leftPercent: 25, resetAtMs: NOW + 60_000 }],
			})),
		}, overviewPath());
		const cached = await readMany();
		expect(cached[0]?.accounts[3]).toMatchObject({ enabled: false, quota: { stale: true, limits: [{ leftPercent: 25 }] } });
		vi.setSystemTime(NOW + 2 * INTERVAL);
		mocks.config.quotaSidebar!.color = "#abcdef";
		await readMany(12, 150);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(ensureCodexUsageAccessToken).not.toHaveBeenCalled();
		await expect(readFile(`${overviewPath()}.attempt.json`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("uses active response headers without polling until an enabled sidebar asks for resets", async () => {
		const active = mocks.pool!.accounts[0]!;
		await writeTuiQuotaSnapshot({
			version: TUI_QUOTA_CACHE_VERSION, fingerprint: createUsageAccountFingerprint(active), fetchedAt: NOW, source: "headers",
			limits: [{ label: "weekly", leftPercent: 80, resetAtMs: NOW + 60_000 }],
		});
		mocks.config.quotaSidebar!.enabled = false;
		const hidden = await readMany();
		expect(hidden[0]?.accounts[0]?.quota?.limits[0]?.leftPercent).toBe(80);
		expect(fetchMock).not.toHaveBeenCalled();
		mocks.config.quotaSidebar!.enabled = true;
		mocks.config.quotaSidebar!.showQuota = false;
		mocks.config.quotaSidebar!.showResetTimes = false;
		await readMany();
		expect(fetchMock).not.toHaveBeenCalled();
		mocks.config.quotaSidebar!.showResetTimes = true;
		const resetOnly = await readMany();
		expect(resetOnly[0]?.sidebar).toMatchObject({ enabled: true, showQuota: false, showResetTimes: true });
		expect(fetchMock).toHaveBeenCalledTimes(ENABLED_IDS.length);
		expect(resetOnly[0]?.accounts[1]?.quota?.limits[0]?.resetAtMs).toBe(NOW + 2 * 86_400_000);
		expect(requestedAccountIds()).not.toContain("FAKE_ACCOUNT_DISABLED");
	});
});
