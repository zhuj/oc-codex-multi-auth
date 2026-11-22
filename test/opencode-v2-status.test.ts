import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStorageV3 } from "../lib/storage.js";
import type { PluginConfig } from "../lib/types.js";

const mocks = vi.hoisted(() => ({
	overview: vi.fn(),
	cachedOverview: vi.fn(),
	promptStatus: vi.fn(),
	resetsParams: vi.fn(),
	sharedSnapshot: vi.fn(),
	projectRoot: null as string | null,
	freshSnapshot: true,
	quotaStatus: undefined as Record<string, unknown> | undefined,
	config: {} as PluginConfig,
	pool: null as AccountStorageV3 | null,
	realFormat: false,
	overviewAccounts: undefined as unknown[] | undefined,
}));

vi.mock("../lib/config.js", async (original) => ({
	...await original<typeof import("../lib/config.js")>(),
	loadPluginConfig: () => ({ maskEmail: true, ...mocks.config, quotaStatus: mocks.quotaStatus }),
	getCodexTuiMaskEmail: () => true,
}));
vi.mock("../lib/storage.js", () => ({
	getStoragePath: () => "/tmp/opencode/accounts.json",
	loadAccounts: async () => mocks.pool,
}));
vi.mock("../lib/storage/state.js", () => ({
	getCurrentProjectRoot: () => mocks.projectRoot,
}));
vi.mock("../lib/tui-quota-cache.js", () => ({
	readTuiQuotaSnapshot: mocks.sharedSnapshot,
	readTuiQuotaOverviewSnapshot: mocks.cachedOverview,
	isFreshTuiQuotaSnapshot: () => mocks.freshSnapshot,
	TUI_QUOTA_OVERVIEW_CACHE_FILE: "overview.json",
	TUI_QUOTA_CACHE_VERSION: 1,
}));
vi.mock("../lib/tui-quota-overview.js", async (original) => ({
	...await original<typeof import("../lib/tui-quota-overview.js")>(),
	fetchTuiQuotaOverview: mocks.overview,
	toQuotaOverviewAccounts: (snapshot: { accounts: Array<{ index: number; limits: Array<{ leftPercent: number | null; resetAtMs?: number }> }> }) => mocks.overviewAccounts ?? snapshot.accounts.map((row) => ({ ...row, windows: row.limits.map((limit) => ({ ...limit, leftPercent: limit.leftPercent ?? undefined })) })),
}));
vi.mock("../lib/tui-status.js", async (original) => {
	const real = await original<typeof import("../lib/tui-status.js")>();
	return {
		...real,
		formatPromptStatusText: (options: Parameters<typeof real.formatPromptStatusText>[0]) => {
			mocks.promptStatus(options);
			return mocks.realFormat ? real.formatPromptStatusText(options) : "quota";
		},
		formatQuotaResetsStatusLines: (params: unknown) => { mocks.resetsParams(params); return []; },
		formatQuotaOverviewStatusLines: (params: Parameters<typeof real.formatQuotaOverviewStatusLines>[0]) =>
			mocks.realFormat ? real.formatQuotaOverviewStatusLines(params) : ["pool 40%"],
	};
});
import { readV2Status, resetV2StatusThrottle } from "../lib/opencode-v2-status.js";
import { resolveDisplayEmail } from "../lib/account-display.js";
import { createUsageAccountFingerprint } from "../lib/codex-usage.js";
import { displayWidth } from "../lib/ui/display-text.js";
import { CodexStatusRpc } from "../lib/opencode-v2-rpc.js";

beforeEach(() => {
	resetV2StatusThrottle();
	mocks.overview.mockReset();
	mocks.cachedOverview.mockReset();
	mocks.sharedSnapshot.mockReset();
	mocks.sharedSnapshot.mockResolvedValue(null);
	mocks.quotaStatus = undefined;
	mocks.config = {};
	mocks.pool = { version: 3, activeIndex: 1, accounts: [
		{ email: "first@example.com", refreshToken: "private-refresh", accessToken: "private-access", enabled: false, addedAt: 0, lastUsed: 0 },
		{ accountLabel: "Work", email: "second@example.com", refreshToken: "another-refresh", addedAt: 0, lastUsed: 0 },
	] };
	mocks.projectRoot = null;
	mocks.freshSnapshot = true;
});

it("reports the effective account storage scope", async () => {
	mocks.overview.mockResolvedValue(null);
	expect((await readV2Status({ width: 80 })).accountStorage).toBe("global");
	mocks.projectRoot = "/tmp/opencode/project";
	expect((await readV2Status({ width: 80 })).accountStorage).toBe("project");
});

it("lists every account with masked identities even when quota is unavailable", async () => {
	mocks.overview.mockResolvedValue(null);
	const result = await readV2Status({ width: 80 });
	expect(result.accounts).toMatchObject([
		{ index: 1, label: resolveDisplayEmail("first@example.com", true), active: false, enabled: false },
		{ index: 2, label: "Work", active: true, enabled: true },
	]);
	expect(JSON.stringify(result)).not.toMatch(/private-refresh|private-access|another-refresh|first@example.com|second@example.com/);
});

it("marks the account serving requests rather than the selected pool account", async () => {
	mocks.overview.mockResolvedValue(null);
	mocks.sharedSnapshot.mockResolvedValue({
		source: "headers", fingerprint: createUsageAccountFingerprint({ refreshToken: "private-refresh" }),
		fetchedAt: Date.now(), limits: [],
	});
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([true, false]);
	mocks.freshSnapshot = false;
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([false, true]);
	mocks.freshSnapshot = true;

	// Another project or a removed account must not influence this pool's sidebar.
	mocks.sharedSnapshot.mockResolvedValue({ source: "headers", fingerprint: "other-pool", fetchedAt: Date.now(), limits: [] });
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([false, true]);
});

it("does not attribute a shared headers snapshot to another seeded project", async () => {
	mocks.overview.mockResolvedValue(null);
	mocks.sharedSnapshot.mockResolvedValue({
		source: "headers", fingerprint: createUsageAccountFingerprint({ refreshToken: "private-refresh" }),
		fetchedAt: Date.now(), limits: [],
	});
	mocks.projectRoot = "/tmp/opencode/project-a";
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([false, true]);
	mocks.projectRoot = "/tmp/opencode/project-b";
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([false, true]);
});

it("does not mistake a usage poll for a serving-account change", async () => {
	mocks.overview.mockResolvedValue(null);
	mocks.sharedSnapshot.mockResolvedValue({
		source: "usage", fingerprint: createUsageAccountFingerprint({ refreshToken: "private-refresh" }),
		fetchedAt: Date.now(), limits: [],
	});
	expect((await readV2Status({ width: 80 })).accounts.map((account) => account.active)).toEqual([false, true]);
});

it("uses a one-based account index in the V2 quota status", async () => {
	mocks.overview.mockResolvedValue({
		fetchedAt: Date.now(),
		accounts: [{ fingerprint: createUsageAccountFingerprint({ refreshToken: "another-refresh" }), limits: [] }],
	});
	await readV2Status({ width: 80 });
	expect(mocks.promptStatus).toHaveBeenLastCalledWith(expect.objectContaining({
		quota: expect.objectContaining({ accountIndex: 2, accountCount: 2 }),
	}));
});

it("delegates stale-cache polling to the shared bounded producer", async () => {
	const stale = { fetchedAt: 0, accounts: [] };
	mocks.overview.mockResolvedValue(stale);
	mocks.cachedOverview.mockResolvedValue(stale);
	for (let poll = 0; poll < 5; poll += 1) await readV2Status({ width: 80 });
	expect(mocks.overview).toHaveBeenCalledTimes(5);
	for (const [options] of mocks.overview.mock.calls) {
		expect(options).toMatchObject({ cachePath: "/tmp/opencode/overview.json", enabled: true, refreshIntervalMs: 600_000 });
	}
});

it("skips an empty resets screen instead of blanking the status line", async () => {
	mocks.quotaStatus = { mode: ["resets"] };
	const snapshot = { fetchedAt: Date.now(), accounts: [] };
	mocks.overview.mockResolvedValue(snapshot);
	mocks.cachedOverview.mockResolvedValue(snapshot);
	expect((await readV2Status({ width: 80 })).text).toBe("");

	resetV2StatusThrottle();
	mocks.quotaStatus = { mode: ["overview", "resets"], rotateMs: 1_000 };
	const seen = new Set<string>();
	const now = vi.spyOn(Date, "now");
	for (const at of [0, 1_000, 2_000, 3_000]) {
		now.mockReturnValue(at);
		seen.add((await readV2Status({ width: 80 })).text);
	}
	now.mockRestore();
	expect([...seen]).toEqual(["pool 40%"]);
});

it("uses the producer's in-memory result without requiring a disk-cache read", async () => {
	mocks.quotaStatus = { mode: ["overview"] };
	mocks.overview.mockResolvedValue({ fetchedAt: Date.now(), accounts: [] });
	mocks.cachedOverview.mockResolvedValue(undefined);
	expect((await readV2Status({ width: 80 })).text).toBe("pool 40%");
	expect((await readV2Status({ width: 80 })).text).toBe("pool 40%");
	expect(mocks.cachedOverview).not.toHaveBeenCalled();
});

it("passes resetsMinUsedPercent to the V2 resets screen", async () => {
	mocks.quotaStatus = { mode: ["resets"], resetsMinUsedPercent: 80 };
	mocks.overview.mockResolvedValue({ fetchedAt: Date.now(), accounts: [] });
	await readV2Status({ width: 80 });
	expect(mocks.resetsParams).toHaveBeenLastCalledWith(expect.objectContaining({ resetsMinUsedPercent: 80 }));
});

describe("V2 configurable identities and sidebar quota", () => {
	afterEach(() => { mocks.realFormat = false; });

	it("shows short aliases even with no quota and applies config edits without changing account identity", async () => {
		mocks.realFormat = true;
		mocks.config = { accountShortNames: { "second@example.com": "work" } };
		let result = await readV2Status({ width: 120 });
		expect(result.text).toContain("[work]");
		expect(result.text).not.toContain("example.com");
		expect(result.accounts[1]).toMatchObject({ shortName: "work", displayName: "[work]", active: true });
		expect(result.accounts[0]?.displayName).toBe("[A1]");
		mocks.config.accountShortNames!["second@example.com"] = "personal";
		result = await readV2Status({ width: 120 });
		expect(result.text).toContain("[personal]");
		mocks.quotaStatus = { activeAccountName: "none" };
		expect((await readV2Status({ width: 120 })).text).not.toContain("[personal]");
	});

	it("masks email substrings in full account labels before sending the RPC", async () => {
		mocks.pool!.accounts[1]!.accountLabel = "Work <second@example.com>\u001b[31m";
		mocks.config = { quotaSidebar: { accountNames: "full" } };
		const result = await readV2Status({ width: 100 });
		expect(result.accounts[1]?.displayName).toContain("Work <se***@example.com>");
		expect(JSON.stringify(result)).not.toMatch(/second@example\.com|\\u001b/);
	});

	it("merges newer serving-account headers without replacing them with the selected account's quota", async () => {
		const now = Date.now();
		const firstFingerprint = createUsageAccountFingerprint(mocks.pool!.accounts[0]!);
		const secondFingerprint = createUsageAccountFingerprint(mocks.pool!.accounts[1]!);
		mocks.overview.mockResolvedValue({ version: 1, fetchedAt: now - 60_000, accounts: [
			{ index: 1, fingerprint: firstFingerprint, fetchedAt: now - 60_000, limits: [{ label: "5h", leftPercent: 70 }], readFailedAt: now - 30_000, readError: "private-access" },
			{ index: 2, fingerprint: secondFingerprint, fetchedAt: now - 60_000, limits: [{ label: "5h", leftPercent: 99 }] },
		] });
		mocks.sharedSnapshot.mockResolvedValue({ version: 1, source: "headers", fingerprint: firstFingerprint, fetchedAt: now,
			limits: [{ label: "5h", leftPercent: 9, usedPercent: 91, windowMinutes: 300, resetAtMs: now + 60_000 }] });
		const result = await readV2Status({ width: 120 });
		expect(result.accounts.map((account) => account.active)).toEqual([true, false]);
		expect(result.accounts[0]?.quota).toMatchObject({ stale: false, readFailed: false, fetchedAt: now, limits: [{ leftPercent: 9, resetAtMs: now + 60_000 }] });
		expect(result.accounts[1]?.quota?.limits[0]?.leftPercent).toBe(99);
		expect(mocks.promptStatus).toHaveBeenLastCalledWith(expect.objectContaining({ quota: expect.objectContaining({ accountIndex: 1, limits: [expect.objectContaining({ leftPercent: 9 })] }) }));
		expect(result.statusTone).toBe("danger");
		expect(JSON.stringify(result)).not.toMatch(/private-access|private-refresh|another-refresh|readError|fingerprint/);
		expect(CodexStatusRpc.methods.status.output.safeParse(result).success).toBe(true);
	});

	it("uses the selected project's account while sharing matching account quota observations", async () => {
		mocks.projectRoot = "/tmp/project";
		const now = Date.now();
		mocks.overview.mockResolvedValue({ version: 1, fetchedAt: now, accounts: [
			{ index: 2, fingerprint: createUsageAccountFingerprint(mocks.pool!.accounts[1]!), limits: [{ label: "5h", leftPercent: 48 }] },
		] });
		mocks.sharedSnapshot.mockResolvedValue({ version: 1, source: "headers", fingerprint: createUsageAccountFingerprint(mocks.pool!.accounts[0]!), fetchedAt: now,
			limits: [{ label: "5h", leftPercent: 7 }] });
		const result = await readV2Status({ width: 120 });
		expect(result.accounts.map((row) => row.active)).toEqual([false, true]);
		expect(result.accounts[0]?.quota?.limits[0]?.leftPercent).toBe(7);
		expect(mocks.promptStatus).toHaveBeenLastCalledWith(expect.objectContaining({ quota: expect.objectContaining({ accountIndex: 2, limits: [expect.objectContaining({ leftPercent: 48 })] }) }));
	});

	it("remaps current account indices and excludes disabled or foreign rows from aggregation", async () => {
		const now = Date.now();
		mocks.quotaStatus = { mode: "resets" };
		mocks.overview.mockResolvedValue({ version: 1, fetchedAt: now, accounts: [
			{ index: 9, fingerprint: createUsageAccountFingerprint(mocks.pool!.accounts[0]!), limits: [{ label: "5h", leftPercent: 100 }] },
			{ index: 8, fingerprint: createUsageAccountFingerprint(mocks.pool!.accounts[1]!), limits: [{ label: "weekly", leftPercent: 0 }] },
			{ index: 2, fingerprint: "not-in-this-pool", limits: [{ label: "5h", leftPercent: 98 }] },
		] });
		const result = await readV2Status({ width: 120 });
		expect(result.accounts).toHaveLength(2);
		expect(result.accounts[0]?.quota?.limits[0]?.leftPercent).toBe(100);
		expect(result.accounts[1]?.quota?.limits[0]?.leftPercent).toBe(0);
		expect(mocks.resetsParams).toHaveBeenLastCalledWith(expect.objectContaining({ accounts: [expect.objectContaining({ index: 2, shortName: "A2" })] }));
	});

	it("reports per-account stale/failed state instead of making missing data a zero percentage", async () => {
		const now = Date.now();
		mocks.config = { quotaSidebar: { color: "#12ab34", accountNames: "none" } };
		mocks.quotaStatus = { color: "accent" };
		mocks.overview.mockResolvedValue({ version: 1, fetchedAt: now - 700_000, accounts: [
			{ index: 2, fingerprint: createUsageAccountFingerprint(mocks.pool!.accounts[1]!), fetchedAt: now - 700_000,
				readFailedAt: now - 1_000, readError: "FAKE_SECRET", limits: [{ label: "5h", leftPercent: null }] },
		] });
		const result = await readV2Status({ width: 120 });
		expect(result.accounts[0]?.quota).toBeUndefined();
		expect(result.accounts[1]?.quota).toMatchObject({ stale: true, readFailed: true, limits: [{ leftPercent: null }] });
		expect(result.accounts.every((row) => row.displayName === "")).toBe(true);
		expect(result.statusColor).toBe("accent");
		expect(result.statusTone).toBe("stale");
		expect(result.sidebar.color).toBe("#12ab34");
		expect(JSON.stringify(result)).not.toContain("FAKE_SECRET");
	});

	it("only requests pool data when a display needs it and passes the cache-only switch", async () => {
		mocks.sharedSnapshot.mockResolvedValue({ version: 1, source: "headers", fingerprint: createUsageAccountFingerprint(mocks.pool!.accounts[1]!), fetchedAt: Date.now(), limits: [{ label: "5h", leftPercent: 72 }] });
		mocks.config = { quotaSidebar: { enabled: false } };
		await readV2Status({ width: 80 });
		expect(mocks.overview).not.toHaveBeenCalled();
		mocks.config = { quotaSidebar: { showQuota: false, showResetTimes: false } };
		await readV2Status({ width: 80 });
		expect(mocks.overview).not.toHaveBeenCalled();
		mocks.config = { quotaSidebar: { showQuota: false, showResetTimes: true }, quotaRefresh: { enabled: false, intervalMs: 1_800_000 } };
		await readV2Status({ width: 80 });
		expect(mocks.overview).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, refreshIntervalMs: 1_800_000 }));
	});
});


it.each([
	"OpenAI ",
	"中文 ",
	"e\u0301 ",
])("puts the V2 prefix %s before the line", async (prefix) => {
	mocks.overview.mockResolvedValue(null);
	mocks.quotaStatus = { prefix };
	expect((await readV2Status({ width: 80 })).text).toBe(`${prefix}quota`);
});

describe("V2 prefix width budget", () => {
	beforeEach(() => {
		mocks.realFormat = true;
		mocks.quotaStatus = { activeAccountName: "full" };
		mocks.overview.mockResolvedValue({ fetchedAt: Date.now(), accounts: [] });
		mocks.sharedSnapshot.mockResolvedValue({
			source: "headers", fingerprint: createUsageAccountFingerprint({ refreshToken: "another-refresh" }),
			fetchedAt: Date.now(), accountIndex: 2, accountCount: 2, accountEmail: "second@example.com",
			limits: [
				{ label: "5h", leftPercent: 8, resetAtMs: Date.now() + 2 * 3_600_000 + 60_000 },
				{ label: "7d", leftPercent: 83 },
			],
		});
	});
	afterEach(() => {
		mocks.realFormat = false;
		mocks.overviewAccounts = undefined;
	});

	it("keeps the width tier of the bare line when a prefix is set", async () => {
		const bare = (await readV2Status({ width: 78 })).text;
		// A 78-column terminal gets 42 columns; the next tier down gets 32.
		expect(displayWidth(bare)).toBeGreaterThan(32);
		expect(displayWidth(bare)).toBeLessThanOrEqual(41);
		mocks.quotaStatus = { activeAccountName: "full", prefix: ">" };
		expect((await readV2Status({ width: 78 })).text).toBe(`>${bare}`);
	});

	it("takes the prefix out of the width tier's budget", async () => {
		const snapshot = await mocks.sharedSnapshot();
		mocks.sharedSnapshot.mockResolvedValue({ ...snapshot, accountEmail: "second@eng.university.example.com" });
		mocks.pool!.accounts[1]!.email = "second@eng.university.example.com";
		const bare = (await readV2Status({ width: 130 })).text;
		// A 130-column terminal gets 64 columns.
		expect(displayWidth(bare)).toBeGreaterThan(64 - 7);
		expect(displayWidth(bare)).toBeLessThanOrEqual(64);
		mocks.quotaStatus = { activeAccountName: "full", prefix: "OpenAI " };
		const { text } = await readV2Status({ width: 130 });
		expect(text.startsWith("OpenAI ")).toBe(true);
		expect(displayWidth(text)).toBeLessThanOrEqual(64);
	});

	it("hides the line when the prefix leaves no room", async () => {
		mocks.overviewAccounts = [1, 2, 3].map((index) => ({
			index,
			email: `user${index}@example.com`,
			planType: "plus",
			windows: [{ leftPercent: 40 + index, resetAtMs: Date.now() + 3 * 86_400_000, windowMinutes: 10_080 }],
		}));
		mocks.quotaStatus = { mode: "overview" };
		expect((await readV2Status({ width: 40 })).text).not.toBe("");
		mocks.quotaStatus = { mode: "overview", prefix: "\u4e2d".repeat(20) };
		expect((await readV2Status({ width: 40 })).text).toBe("");
	});
});
