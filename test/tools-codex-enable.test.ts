import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../lib/tools/index.js";
import type { AccountStorageV3 } from "../lib/storage.js";
import { createCodexEnableTool } from "../lib/tools/codex-enable.js";
import {
	AUTH_FAILURE_DISABLE_NOTE_MARKER,
	WORKSPACE_DEACTIVATED_NOTE_MARKER,
} from "../lib/accounts/state.js";
import { resolveDisplayEmail } from "../lib/account-display.js";

vi.mock("../lib/storage.js", async (importOriginal) => ({
	...await importOriginal<typeof import("../lib/storage.js")>(),
	loadAccounts: vi.fn(),
	withAccountStorageTransaction: vi.fn(),
}));

vi.mock("../lib/accounts.js", () => ({
	AccountManager: { loadFromDisk: vi.fn(async () => ({})) },
}));

import { loadAccounts, withAccountStorageTransaction } from "../lib/storage.js";
import { AccountManager } from "../lib/accounts.js";

/**
 * Same transaction stand-in as the codex-remove suite: hands the handler the
 * `current` snapshot and records whatever it chooses to persist.
 */
function stubTransaction(current: AccountStorageV3 | null): {
	getPersisted: () => AccountStorageV3 | undefined;
} {
	let persisted: AccountStorageV3 | undefined;
	vi.mocked(withAccountStorageTransaction).mockImplementation(
		async (handler) => {
			return handler(current, async (s: AccountStorageV3) => {
				persisted = s;
			});
		},
	);
	return { getPersisted: () => persisted };
}

function formatCommandAccountLabel(
	account: { email?: string; accountLabel?: string } | undefined,
	index: number,
	options: { maskEmail?: boolean } = {},
): string {
	const email = resolveDisplayEmail(account?.email, options.maskEmail ?? false);
	const workspace = account?.accountLabel?.trim();
	const details: string[] = [];
	if (email) details.push(email);
	if (workspace) details.push(`workspace:${workspace}`);
	if (details.length === 0) return `Account ${index + 1}`;
	return `Account ${index + 1} (${details.join(", ")})`;
}

function buildCtx(options: { pickIndex?: number | null } = {}): ToolContext {
	const ctx = {
		resolveUiRuntime: () => ({
			v2Enabled: false,
			colorProfile: "ansi16",
			glyphMode: "ascii",
			theme: undefined,
		}),
		resolveMaskEmail: () => false,
		formatCommandAccountLabel,
		getStatusMarker: () => "[ok]",
		promptAccountIndexSelection: vi.fn(async () => options.pickIndex ?? null),
		supportsInteractiveMenus: () => false,
		cachedAccountManagerRef: { current: null },
		accountManagerPromiseRef: { current: null },
		invalidateAccountManagerCache: vi.fn(),
		manualAccountOverrideIdentityRef: { current: null },
		withAccountManagerMutation: async <T>(mutation: () => Promise<T>, shouldReload: (result: T) => boolean): Promise<T> => {
			const result = await mutation();
			if (shouldReload(result)) await AccountManager.loadFromDisk();
			return result;
		},
	};
	return ctx as unknown as ToolContext;
}

function makeStorage(accounts: AccountStorageV3["accounts"]): AccountStorageV3 {
	return { version: 3, activeIndex: 0, accounts };
}

beforeEach(() => {
	vi.mocked(loadAccounts).mockReset();
	vi.mocked(withAccountStorageTransaction).mockReset();
	vi.mocked(AccountManager.loadFromDisk).mockClear();
});

describe("codex-enable tool", () => {
	it("auto-selects the sole disabled account when index is omitted (#288)", async () => {
		const storage = makeStorage([
			{
				email: "sole@example.com",
				refreshToken: "r1",
				addedAt: 1,
				lastUsed: 1,
				enabled: false,
				accountNote: AUTH_FAILURE_DISABLE_NOTE_MARKER,
				coolingDownUntil: 1_800_000_000_000,
				cooldownReason: "auth-failure",
			},
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const { getPersisted } = stubTransaction(storage);

		const tool = createCodexEnableTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;

		expect(output).toContain("Enabled");
		const persisted = getPersisted();
		expect(persisted).toBeDefined();
		const account = persisted!.accounts[0]!;
		expect(account.enabled).toBeUndefined();
		expect(account.accountNote).toBeUndefined();
		// A leftover auth-failure cooldown would keep the account out of
		// rotation even with enabled restored.
		expect(account.coolingDownUntil).toBeUndefined();
		expect(account.cooldownReason).toBeUndefined();
	});

	it("re-enables an explicitly indexed account and preserves operator note text", async () => {
		const storage = makeStorage([
			{
				email: "a@example.com",
				refreshToken: "r1",
				addedAt: 1,
				lastUsed: 1,
				enabled: false,
				accountNote: `primary work account. ${AUTH_FAILURE_DISABLE_NOTE_MARKER}`,
			},
			{ email: "b@example.com", refreshToken: "r2", addedAt: 2, lastUsed: 2 },
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const { getPersisted } = stubTransaction(storage);

		const tool = createCodexEnableTool(buildCtx());
		const output = (await tool.execute({ index: 1 }, {} as never)) as string;

		expect(output).toContain("Enabled");
		const persisted = getPersisted();
		const account = persisted!.accounts[0]!;
		expect(account.enabled).toBeUndefined();
		expect(account.accountNote).toBe("primary work account.");
	});

	it("strips the workspace-deactivation marker on re-enable", async () => {
		const storage = makeStorage([
			{
				email: "seat@example.com",
				refreshToken: "r1",
				addedAt: 1,
				lastUsed: 1,
				enabled: false,
				accountNote: WORKSPACE_DEACTIVATED_NOTE_MARKER,
			},
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const { getPersisted } = stubTransaction(storage);

		const tool = createCodexEnableTool(buildCtx());
		await tool.execute({}, {} as never);

		expect(getPersisted()!.accounts[0]!.accountNote).toBeUndefined();
		expect(getPersisted()!.accounts[0]!.enabled).toBeUndefined();
	});

	it("keeps a non-auth-failure cooldown instead of widening the enable", async () => {
		const storage = makeStorage([
			{
				email: "a@example.com",
				refreshToken: "r1",
				addedAt: 1,
				lastUsed: 1,
				enabled: false,
				accountNote: AUTH_FAILURE_DISABLE_NOTE_MARKER,
				coolingDownUntil: 1_800_000_000_000,
				cooldownReason: "network-error",
			},
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const { getPersisted } = stubTransaction(storage);

		const tool = createCodexEnableTool(buildCtx());
		await tool.execute({}, {} as never);

		const account = getPersisted()!.accounts[0]!;
		expect(account.enabled).toBeUndefined();
		expect(account.coolingDownUntil).toBe(1_800_000_000_000);
		expect(account.cooldownReason).toBe("network-error");
	});

	it("reports an already-enabled account without persisting", async () => {
		const storage = makeStorage([
			{ email: "a@example.com", refreshToken: "r1", addedAt: 1, lastUsed: 1 },
			{
				email: "b@example.com",
				refreshToken: "r2",
				addedAt: 2,
				lastUsed: 2,
				enabled: false,
				accountNote: AUTH_FAILURE_DISABLE_NOTE_MARKER,
			},
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const { getPersisted } = stubTransaction(storage);

		const tool = createCodexEnableTool(buildCtx());
		const output = (await tool.execute({ index: 1 }, {} as never)) as string;

		expect(output).toContain("already enabled");
		expect(getPersisted()).toBeUndefined();
	});

	it("rejects an out-of-range index without persisting", async () => {
		const storage = makeStorage([
			{
				email: "a@example.com",
				refreshToken: "r1",
				addedAt: 1,
				lastUsed: 1,
				enabled: false,
				accountNote: AUTH_FAILURE_DISABLE_NOTE_MARKER,
			},
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const { getPersisted } = stubTransaction(storage);

		const tool = createCodexEnableTool(buildCtx());
		const output = (await tool.execute({ index: 5 }, {} as never)) as string;

		expect(output).toContain("Invalid account number");
		expect(getPersisted()).toBeUndefined();
	});

	it("rejects a fractional index without persisting", async () => {
		const storage = makeStorage([
			{
				email: "a@example.com",
				refreshToken: "r1",
				addedAt: 1,
				lastUsed: 1,
				enabled: false,
				accountNote: AUTH_FAILURE_DISABLE_NOTE_MARKER,
			},
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const { getPersisted } = stubTransaction(storage);

		const tool = createCodexEnableTool(buildCtx());
		const output = (await tool.execute({ index: 1.9 }, {} as never)) as string;

		expect(output).toContain("Invalid account number");
		expect(getPersisted()).toBeUndefined();
	});

	it("lists disabled slots instead of picking when several are disabled and menus are unavailable", async () => {
		const storage = makeStorage([
			{
				email: "a@example.com",
				refreshToken: "r1",
				addedAt: 1,
				lastUsed: 1,
				enabled: false,
				accountNote: AUTH_FAILURE_DISABLE_NOTE_MARKER,
			},
			{
				email: "b@example.com",
				refreshToken: "r2",
				addedAt: 2,
				lastUsed: 2,
				enabled: false,
				accountNote: WORKSPACE_DEACTIVATED_NOTE_MARKER,
			},
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const { getPersisted } = stubTransaction(storage);

		const tool = createCodexEnableTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;

		expect(output).toContain("Disabled slots: 1, 2");
		expect(getPersisted()).toBeUndefined();
	});

	it("uses the picker selection when menus return one", async () => {
		const storage = makeStorage([
			{
				email: "a@example.com",
				refreshToken: "r1",
				addedAt: 1,
				lastUsed: 1,
				enabled: false,
				accountNote: AUTH_FAILURE_DISABLE_NOTE_MARKER,
			},
			{
				email: "b@example.com",
				refreshToken: "r2",
				addedAt: 2,
				lastUsed: 2,
				enabled: false,
				accountNote: WORKSPACE_DEACTIVATED_NOTE_MARKER,
			},
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const { getPersisted } = stubTransaction(storage);

		const tool = createCodexEnableTool(buildCtx({ pickIndex: 1 }));
		const output = (await tool.execute({}, {} as never)) as string;

		expect(output).toContain("Enabled");
		const persisted = getPersisted()!;
		expect(persisted.accounts[1]!.enabled).toBeUndefined();
		expect(persisted.accounts[0]!.enabled).toBe(false);
	});

	it("reports when every account is already enabled", async () => {
		const storage = makeStorage([
			{ email: "a@example.com", refreshToken: "r1", addedAt: 1, lastUsed: 1 },
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const { getPersisted } = stubTransaction(storage);

		const tool = createCodexEnableTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;

		expect(output).toContain("No disabled accounts");
		expect(getPersisted()).toBeUndefined();
	});

	it("reports when no accounts are configured", async () => {
		const storage = makeStorage([]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		const { getPersisted } = stubTransaction(storage);

		const tool = createCodexEnableTool(buildCtx());
		const output = (await tool.execute({}, {} as never)) as string;

		expect(output).toContain("No Codex accounts configured");
		expect(getPersisted()).toBeUndefined();
	});

	it("reloads the cached account manager after a successful enable", async () => {
		const storage = makeStorage([
			{
				email: "a@example.com",
				refreshToken: "r1",
				addedAt: 1,
				lastUsed: 1,
				enabled: false,
				accountNote: AUTH_FAILURE_DISABLE_NOTE_MARKER,
			},
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		stubTransaction(storage);

		const ctx = buildCtx();
		ctx.cachedAccountManagerRef.current = {} as never;
		const tool = createCodexEnableTool(ctx);
		await tool.execute({}, {} as never);

		expect(vi.mocked(AccountManager.loadFromDisk)).toHaveBeenCalled();
	});

	it("reloads even when an in-flight prior load already rejected", async () => {
		const storage = makeStorage([
			{
				email: "a@example.com",
				refreshToken: "r1",
				addedAt: 1,
				lastUsed: 1,
				enabled: false,
				accountNote: AUTH_FAILURE_DISABLE_NOTE_MARKER,
			},
		]);
		vi.mocked(loadAccounts).mockResolvedValue(storage);
		stubTransaction(storage);

		const priorLoad = Promise.reject(new Error("stale load failed"));
		void priorLoad.catch(() => undefined);
		const ctx = buildCtx();
		ctx.accountManagerPromiseRef.current = priorLoad;
		ctx.cachedAccountManagerRef.current = {} as never;
		const tool = createCodexEnableTool(ctx);
		const output = (await tool.execute({}, {} as never)) as string;

		expect(vi.mocked(AccountManager.loadFromDisk)).toHaveBeenCalled();
		expect(output).toContain("Enabled");
		expect(output).not.toContain("reload failed");
	});
});
