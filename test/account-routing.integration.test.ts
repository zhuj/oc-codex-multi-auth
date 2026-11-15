import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountManager } from "../lib/accounts.js";
import type { AccountStorageV3 } from "../lib/storage.js";

const { storageRef, transactionGateRef, transactionStartedRef, persistObserverRef, rotationStrategyRef } = vi.hoisted(() => ({
	rotationStrategyRef: { current: "hybrid" as "hybrid" | "custom" },
	storageRef: { current: null as AccountStorageV3 | null },
	transactionGateRef: { current: null as Promise<void> | null },
	transactionStartedRef: { current: null as (() => void) | null },
	persistObserverRef: { current: null as ((storage: AccountStorageV3) => void) | null },
}));

const cloneStorage = (storage: AccountStorageV3 | null): AccountStorageV3 | null =>
	storage ? structuredClone(storage) : null;

vi.mock("../lib/storage.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/storage.js")>();
	return {
		...actual,
		getStoragePath: () => "/in-memory/accounts.json",
		setStoragePath: vi.fn(),
		loadAccounts: vi.fn(async () => cloneStorage(storageRef.current)),
		saveAccounts: vi.fn(async (storage: AccountStorageV3) => {
			storageRef.current = cloneStorage(storage);
		}),
		withAccountStorageTransaction: vi.fn(
			async <T>(
				handler: (
					current: AccountStorageV3 | null,
					persist: (storage: AccountStorageV3) => Promise<void>,
				) => Promise<T>,
			): Promise<T> => {
				const gate = transactionGateRef.current;
				transactionGateRef.current = null;
				if (gate) {
					transactionStartedRef.current?.();
					await gate;
				}
				return handler(cloneStorage(storageRef.current), async (storage) => {
					storageRef.current = cloneStorage(storage);
					persistObserverRef.current?.(storage);
				});
			},
		),
		loadFlaggedAccounts: vi.fn(async () => null),
		saveFlaggedAccounts: vi.fn(async () => {}),
		withFlaggedAccountStorageTransaction: vi.fn(),
		clearFlaggedAccounts: vi.fn(async () => {}),
	};
});

vi.mock("../lib/config.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/config.js")>();
	return {
		...actual,
		getAccountToastsEnabled: () => false,
		getAutoResume: () => false,
		getAutoUpdate: () => false,
		getCodexMode: () => true,
		getPerProjectAccounts: () => false,
		getRequestTransformMode: () => "native",
		getRetryAllAccountsMaxWaitMs: () => 0,
		getRotationStrategy: () => rotationStrategyRef.current,
		getSessionRecovery: () => false,
		loadPluginConfig: () => ({}),
	};
});

vi.mock("../lib/request/fetch-helpers.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/request/fetch-helpers.js")>();
	return {
		...actual,
		createCodexHeaders: vi.fn(
			(_request: Request, _accountId: string | undefined, accessToken: string) =>
				new Headers({ "x-test-access-token": accessToken }),
		),
		extractRequestUrl: (input: unknown) => String(input),
		handleErrorResponse: vi.fn(async (response: Response) => ({ response })),
		handleSuccessResponse: vi.fn(async (response: Response) => response),
		isDeactivatedWorkspaceError: () => false,
		isInvalidatedAuthTokenError: () => false,
		refreshAndUpdateToken: vi.fn(async (auth: unknown) => auth),
		rewriteUrlForCodex: (url: string) => url,
		shouldRefreshToken: () => false,
		transformRequestForCodex: vi.fn(async (init: RequestInit) => ({
			updatedInit: init,
			body: { model: "gpt-5.1" },
		})),
	};
});

vi.mock("../lib/prompts/codex.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/prompts/codex.js")>();
	return {
		...actual,
		getCodexInstructions: vi.fn(async () => "test instructions"),
		prewarmCodexInstructions: vi.fn(),
	};
});

vi.mock("../lib/prompts/opencode-codex.js", () => ({
	prewarmOpenCodeCodexPrompt: vi.fn(),
}));

vi.mock("../lib/auto-update-checker.js", () => ({
	checkAndNotify: vi.fn(async () => {}),
}));

vi.mock("../lib/custom-rotation/monitor.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/custom-rotation/monitor.js")>();
	return {
		...actual,
		createRotationMonitor: () => actual.createRotationMonitor({ enabled: () => false }),
	};
});

vi.mock("../lib/tui-quota-cache.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../lib/tui-quota-cache.js")>();
	return { ...actual, clearTuiQuotaSnapshot: vi.fn(async () => {}) };
});

type PluginRuntime = {
	auth: {
		loader: (
			getAuth: () => Promise<unknown>,
			provider: unknown,
		) => Promise<{ fetch?: (input: unknown, init?: RequestInit) => Promise<Response> }>;
	};
	tool: {
		"codex-switch": { execute: (args: { index: number }) => Promise<string> };
		"codex-enable": { execute: (args: { index: number }) => Promise<string> };
		"codex-remove": {
			execute: (args: { index: number; confirm: boolean }) => Promise<string>;
		};
	};
};

const getAuth = async () => ({
	type: "oauth" as const,
	access: "access-A",
	refresh: "refresh-A",
	expires: Date.now() + 3_600_000,
	multiAccount: true,
});

async function createRuntime(): Promise<{
	plugin: PluginRuntime;
	request: NonNullable<Awaited<ReturnType<PluginRuntime["auth"]["loader"]>>["fetch"]>;
}> {
	const { OpenAIOAuthPlugin } = await import("../index.js");
	const client = {
		tui: { showToast: vi.fn() },
		auth: { set: vi.fn() },
		session: { prompt: vi.fn() },
	};
	const plugin = (await OpenAIOAuthPlugin({ client } as never)) as unknown as PluginRuntime;
	const sdk = await plugin.auth.loader(getAuth, { options: {}, models: {} });
	if (!sdk.fetch) throw new Error("Expected plugin fetch implementation");
	return { plugin, request: sdk.fetch };
}

async function createRuntimeWithManager(): Promise<{
	plugin: PluginRuntime;
	request: NonNullable<Awaited<ReturnType<PluginRuntime["auth"]["loader"]>>["fetch"]>;
	manager: AccountManager;
}> {
	const { AccountManager } = await import("../lib/accounts.js");
	const loadSpy = vi.spyOn(AccountManager, "loadFromDisk");
	const runtime = await createRuntime();
	const manager = await loadSpy.mock.results[0]?.value;
	if (!manager) throw new Error("Expected initial account manager");
	return { ...runtime, manager };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve: () => resolvePromise?.(),
	};
}

async function resolvesBeforeNextTurn(promise: Promise<void>): Promise<boolean> {
	return Promise.race([
		promise.then(() => true),
		new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
	]);
}

function selectedTokens(fetchMock: ReturnType<typeof vi.fn>): Array<string | null> {
	return fetchMock.mock.calls.map((call) =>
		new Headers((call[1] as RequestInit | undefined)?.headers).get("x-test-access-token"),
	);
}

describe("plugin account routing with the real AccountManager", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		rotationStrategyRef.current = "hybrid";
		transactionGateRef.current = null;
		transactionStartedRef.current = null;
		persistObserverRef.current = null;
		storageRef.current = {
			version: 3,
			accounts: [
				{
					accountId: "A",
					organizationId: "A",
					refreshToken: "refresh-A",
					accessToken: "access-A",
					expiresAt: Date.now() + 3_600_000,
					enabled: false,
					userDisabled: true,
					addedAt: 1,
					lastUsed: 1,
				},
				{
					accountId: "B",
					organizationId: "B",
					refreshToken: "refresh-B",
					accessToken: "access-B",
					expiresAt: Date.now() + 3_600_000,
					addedAt: 2,
					lastUsed: 2,
				},
			],
			activeIndex: 0,
			activeIndexByFamily: {},
		};
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it.each(["hybrid", "custom"] as const)("%s routes disable, manual switch, failover without losing the switch, and restart through actual selection", async (strategy) => {
		rotationStrategyRef.current = strategy;
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock;
		const first = await createRuntime();

		await first.request("https://api.openai.com/v1/responses", { method: "POST" });
		expect(selectedTokens(fetchMock)).toEqual(["access-B"]);

		await first.plugin.tool["codex-switch"].execute({ index: 1 });
		fetchMock.mockClear();
		await first.request("https://api.openai.com/v1/responses", { method: "POST" });
		expect(selectedTokens(fetchMock)).toEqual(["access-A"]);

		fetchMock.mockClear();
		fetchMock
			.mockResolvedValueOnce(new Response("server error", { status: 500 }))
			.mockResolvedValue(new Response("ok", { status: 200 }));
		await first.request("https://api.openai.com/v1/responses", { method: "POST" });
		expect(selectedTokens(fetchMock)).toEqual(["access-A", "access-B"]);

		fetchMock.mockClear();
		await first.request("https://api.openai.com/v1/responses", { method: "POST" });
		expect(selectedTokens(fetchMock)).toEqual(["access-A"]);

		fetchMock.mockClear();
		const restarted = await createRuntime();
		await restarted.request("https://api.openai.com/v1/responses", { method: "POST" });
		expect(selectedTokens(fetchMock)).toEqual(["access-B"]);
	});

	it("keeps the manual override after one request exhausts every usable account", async () => {
		const { clearCircuitBreakers } = await import("../lib/circuit-breaker.js");
		clearCircuitBreakers();
		// A third, disabled account keeps `accountCount` at three while only two
		// accounts can ever serve, so the traversal leaves its loop through the
		// exhausted-pool branch rather than through its own attempt counter. That
		// branch used to null `manualAccountOverrideIdentity`, silently dropping
		// the user's explicit switch for the rest of the process.
		storageRef.current!.accounts.push({
			accountId: "C",
			organizationId: "C",
			refreshToken: "refresh-C",
			accessToken: "access-C",
			expiresAt: Date.now() + 3_600_000,
			enabled: false,
			addedAt: 3,
			lastUsed: 3,
		});
		const fetchMock = vi.fn(async () => new Response("server error", { status: 500 }));
		globalThis.fetch = fetchMock;
		const first = await createRuntime();

		await first.plugin.tool["codex-switch"].execute({ index: 1 });

		// A 500 rotates without writing a rate-limit window or a cooldown, so B
		// stays selectable after failing and is re-selected on the third pass --
		// the assertion below measures the override, not the health tracker.
		fetchMock.mockClear();
		await first.request("https://api.openai.com/v1/responses", { method: "POST" });
		expect(selectedTokens(fetchMock)).toEqual(["access-A", "access-B"]);

		fetchMock.mockClear();
		fetchMock.mockResolvedValue(new Response("ok", { status: 200 }));
		await first.request("https://api.openai.com/v1/responses", { method: "POST" });
		expect(selectedTokens(fetchMock)).toEqual(["access-A"]);
	});

	it("drains a held save before codex-enable and preserves a different manual override", async () => {
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock;
		const runtime = await createRuntimeWithManager();
		await runtime.plugin.tool["codex-switch"].execute({ index: 1 });
		const { AccountManager } = await import("../lib/accounts.js");
		const incumbent = await vi.mocked(AccountManager.loadFromDisk).mock.results.at(-1)?.value;
		if (!incumbent) throw new Error("Expected incumbent");
		const account = storageRef.current?.accounts[1];
		if (!account) throw new Error("Expected second account");
		account.enabled = false;
		account.userDisabled = true;
		const heldSave = deferred();
		const saveStarted = deferred();
		const enablePersisted = deferred();
		transactionGateRef.current = heldSave.promise;
		transactionStartedRef.current = saveStarted.resolve;
		persistObserverRef.current = (storage) => {
			if (storage.accounts[1]?.enabled !== false) enablePersisted.resolve();
		};
		incumbent.saveToDiskDebounced(0);
		await saveStarted.promise;
		const enable = runtime.plugin.tool["codex-enable"].execute({ index: 2 });
		const mutatedBeforeDrain = await resolvesBeforeNextTurn(enablePersisted.promise);
		heldSave.resolve();
		await enable;
		expect(mutatedBeforeDrain).toBe(false);
		expect(storageRef.current?.accounts[1]?.userDisabled).not.toBe(true);
		fetchMock.mockClear();
		await runtime.request("https://api.openai.com/v1/responses", { method: "POST" });
		expect(selectedTokens(fetchMock)).toEqual(["access-A"]);
	});

	it("does not let a held manager save resurrect a removed account", async () => {
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock;
		storageRef.current!.accounts[0]!.enabled = true;
		storageRef.current!.accounts[0]!.userDisabled = undefined;
		storageRef.current!.activeIndex = 1;
		storageRef.current!.activeIndexByFamily = { codex: 1, "gpt-5.1": 1 };
		const runtime = await createRuntimeWithManager();
		const heldSave = deferred();
		const saveStarted = deferred();
		const removalPersisted = deferred();
		transactionGateRef.current = heldSave.promise;
		transactionStartedRef.current = saveStarted.resolve;
		persistObserverRef.current = (storage) => {
			if (storage.accounts.length === 1) removalPersisted.resolve();
		};

		runtime.manager.saveToDiskDebounced(0);
		await saveStarted.promise;
		const removal = runtime.plugin.tool["codex-remove"].execute({ index: 2, confirm: true });
		const mutatedBeforeDrain = await resolvesBeforeNextTurn(removalPersisted.promise);
		heldSave.resolve();
		await removal;

		expect(mutatedBeforeDrain).toBe(false);
		expect(storageRef.current?.accounts.map((account) => account.accountId)).toEqual(["A"]);
		fetchMock.mockClear();
		await runtime.request("https://api.openai.com/v1/responses", { method: "POST" });
		expect(selectedTokens(fetchMock)).toEqual(["access-A"]);
	});

	it("does not let a held manager save undo an enabled-account switch", async () => {
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		globalThis.fetch = fetchMock;
		storageRef.current!.accounts[0]!.enabled = true;
		storageRef.current!.accounts[0]!.userDisabled = undefined;
		storageRef.current!.activeIndex = 0;
		storageRef.current!.activeIndexByFamily = { codex: 0, "gpt-5.1": 0 };
		const runtime = await createRuntimeWithManager();
		const heldSave = deferred();
		const saveStarted = deferred();
		const switchPersisted = deferred();
		transactionGateRef.current = heldSave.promise;
		transactionStartedRef.current = saveStarted.resolve;
		persistObserverRef.current = (storage) => {
			if (storage.activeIndex === 1) switchPersisted.resolve();
		};

		runtime.manager.saveToDiskDebounced(0);
		await saveStarted.promise;
		const switched = runtime.plugin.tool["codex-switch"].execute({ index: 2 });
		const mutatedBeforeDrain = await resolvesBeforeNextTurn(switchPersisted.promise);
		heldSave.resolve();
		await switched;

		expect(mutatedBeforeDrain).toBe(false);
		expect(storageRef.current?.activeIndex).toBe(1);
		expect(storageRef.current?.activeIndexByFamily?.["gpt-5.1"]).toBe(1);
		fetchMock.mockClear();
		await runtime.request("https://api.openai.com/v1/responses", { method: "POST" });
		expect(selectedTokens(fetchMock)).toEqual(["access-B"]);
	});
});
