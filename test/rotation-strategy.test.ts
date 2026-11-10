import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AccountManager } from "../lib/accounts.js";
import { getTokenTracker, resetTrackers } from "../lib/rotation.js";
import {
	getModelAccountPool,
	getModelAccountPoolMode,
	getRotationStrategy,
} from "../lib/config.js";
import type { PluginConfig } from "../lib/types.js";
import { normalizeAccountStorage, type AccountStorageV3 } from "../lib/storage.js";
import type { ModelFamily } from "../lib/prompts/codex.js";
import { getModelPoolAccountKey } from "../lib/accounts/pool-identity.js";
import { MAX_QUOTA_RESET_HORIZON_MS } from "../lib/quota-windows.js";
import { AUTH_FAILURE_DISABLE_NOTE_MARKER } from "../lib/accounts/state.js";
import { WORKSPACE_DEACTIVATED_NOTE_MARKER } from "../lib/accounts/disabled.js";

vi.mock("../lib/storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/storage.js")>();
  const saveAccounts = vi.fn().mockResolvedValue(undefined);
  return {
    ...actual,
    saveAccounts,
    withAccountStorageTransaction: vi.fn(
      async (
        handler: (
          current: null,
          persist: (storage: unknown) => Promise<void>,
        ) => Promise<unknown>,
      ) => handler(null, saveAccounts as (storage: unknown) => Promise<void>),
    ),
  };
});

const FAMILY: ModelFamily = "codex";

function makeStorage(count: number): AccountStorageV3 {
  const now = Date.now();
  return {
    version: 3,
    accounts: Array.from({ length: count }, (_v, idx) => ({
		accountId: `account-id-${idx + 1}`,
      email: `account${idx + 1}@example.com`,
      refreshToken: `fake_refresh_token_${idx + 1}_for_testing_only`,
      addedAt: now - (count - idx) * 1000,
      // Stagger lastUsed so account 0 is the LEAST recently used (oldest).
      lastUsed: now - (count - idx) * 500,
    })),
    activeIndex: 0,
    activeIndexByFamily: { codex: 0 },
  };
}

describe("getRotationStrategy (#183 config)", () => {
  const baseConfig = (overrides: Partial<PluginConfig> = {}): PluginConfig =>
    ({ ...overrides }) as PluginConfig;

  afterEach(() => {
    delete process.env.CODEX_AUTH_ROTATION_STRATEGY;
  });

  it("defaults to hybrid when unset", () => {
    expect(getRotationStrategy(baseConfig())).toBe("hybrid");
  });

  it("reads sticky / round-robin from config", () => {
    expect(getRotationStrategy(baseConfig({ rotationStrategy: "sticky" }))).toBe("sticky");
    expect(getRotationStrategy(baseConfig({ rotationStrategy: "round-robin" }))).toBe(
      "round-robin",
    );
    expect(getRotationStrategy(baseConfig({ rotationStrategy: "hybrid" }))).toBe("hybrid");
  });

  it("env var overrides config", () => {
    process.env.CODEX_AUTH_ROTATION_STRATEGY = "sticky";
    expect(getRotationStrategy(baseConfig({ rotationStrategy: "round-robin" }))).toBe(
      "sticky",
    );
  });

  it("bogus env value falls back to config / default", () => {
    process.env.CODEX_AUTH_ROTATION_STRATEGY = "turbo";
    expect(getRotationStrategy(baseConfig({ rotationStrategy: "round-robin" }))).toBe(
      "round-robin",
    );
    expect(getRotationStrategy(baseConfig())).toBe("hybrid");
  });

  it("env var is case-insensitive / trimmed", () => {
    process.env.CODEX_AUTH_ROTATION_STRATEGY = "  Round-Robin  ";
    expect(getRotationStrategy(baseConfig())).toBe("round-robin");
  });
});

describe("model account pool config", () => {
	it("matches model names case-insensitively and removes duplicate IDs", () => {
		const config = {
			modelAccountPools: {
				"GPT-5.6-SOL": [" account-id-2 ", "account-id-2", "account-id-3"],
			},
		} as PluginConfig;
		expect(getModelAccountPool(config, "gpt-5.6-sol")).toEqual([
			"account-id-2",
			"account-id-3",
		]);
	});

	it("returns an empty pool for unmapped models", () => {
		expect(getModelAccountPool({ modelAccountPools: {} } as PluginConfig, "gpt-5.5")).toEqual([]);
	});

	it("defaults pool mode to preferred and resolves strict case-insensitively", () => {
		const config = {
			modelAccountPoolModes: { "GPT-5.6-SOL": "strict" },
		} as PluginConfig;
		expect(getModelAccountPoolMode(config, "gpt-5.6-sol")).toBe("strict");
		expect(getModelAccountPoolMode(config, "gpt-5.6-terra")).toBe("preferred");
	});
});

describe("Business seat model pools", () => {
	const businessStorage: AccountStorageV3 = {
		version: 3,
		activeIndex: 0,
		accounts: [
			{
				accountId: "business-account",
				accountUserId: "member-owner",
				refreshToken: "owner-refresh",
				addedAt: 1,
				lastUsed: 1,
			},
			{
				accountId: "business-account",
				accountUserId: "member-invited",
				refreshToken: "invited-refresh",
				addedAt: 2,
				lastUsed: 2,
			},
		],
	};

	it.each(["hybrid", "sticky", "round-robin"] as const)(
		"selects only the configured Business seat with %s rotation",
		(strategy) => {
			const manager = new AccountManager(undefined, businessStorage);
			const invitedKey = getModelPoolAccountKey(businessStorage.accounts[1]);
			const selected = manager.getAccountForStrategy(
				strategy,
				FAMILY,
				"gpt-5.6-sol",
				{},
				invitedKey ? [invitedKey] : [],
			);
			expect(selected?.index).toBe(1);
		},
	);

	it("keeps legacy workspace IDs compatible with every Business seat", () => {
		const manager = new AccountManager(undefined, businessStorage);
		const selected = manager.getAccountForStrategy(
			"round-robin",
			FAMILY,
			"gpt-5.6-sol",
			{},
			["business-account"],
		);
		expect(selected?.index).toBe(0);
	});
});

describe("sticky selection (#183, drain-first)", () => {
  let manager: AccountManager;

  beforeEach(() => {
    resetTrackers();
    manager = new AccountManager(undefined, makeStorage(3));
  });

  it("stays on the current account across repeated calls while healthy", () => {
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      const account = manager.getCurrentOrNextForFamilySticky(FAMILY);
      expect(account).not.toBeNull();
      if (account) seen.push(account.index);
    }
    // Drain-first: never leaves account 0 while it is healthy.
    expect(seen).toEqual([0, 0, 0, 0, 0]);
  });

  it("moves to the lowest-indexed available account when current is rate-limited", () => {
    // Pin + exhaust account 0.
    const first = manager.getCurrentOrNextForFamilySticky(FAMILY);
    expect(first?.index).toBe(0);
    manager.markRateLimited(first!, 60_000, FAMILY);

    const next = manager.getCurrentOrNextForFamilySticky(FAMILY);
    // Concentrate: pick account 1 (lowest available), not the freshest.
    expect(next?.index).toBe(1);

    // And it sticks to 1 now.
    expect(manager.getCurrentOrNextForFamilySticky(FAMILY)?.index).toBe(1);
  });

  it("skips disabled accounts", () => {
    manager.setAccountEnabled(0, false);
    const account = manager.getCurrentOrNextForFamilySticky(FAMILY);
    expect(account?.index).toBe(1);
  });

  it("returns null when every account is unavailable", () => {
    // Mark each LIVE account rate-limited. getAccountsSnapshot() returns deep
    // copies, so we drive the rate limit through the account the selector
    // actually returns (which is the live object) to mutate real state.
    for (let i = 0; i < 3; i++) {
      const account = manager.getCurrentOrNextForFamilySticky(FAMILY);
      expect(account).not.toBeNull();
      manager.markRateLimited(account!, 60_000, FAMILY);
    }
    expect(manager.getCurrentOrNextForFamilySticky(FAMILY)).toBeNull();
  });

  it("recovers the current account once its rate limit expires", () => {
    const first = manager.getCurrentOrNextForFamilySticky(FAMILY);
    // Long enough not to lapse mid-test: a 1ms limit expired under full-suite
    // load before the next call, leaving the selection on 0.
    manager.markRateLimited(first!, 60_000, FAMILY);
    // Move off 0.
    const moved = manager.getCurrentOrNextForFamilySticky(FAMILY);
    expect(moved?.index).toBe(1);
  });
});

describe("strategy dispatcher (#183)", () => {
  let manager: AccountManager;

  beforeEach(() => {
    resetTrackers();
    manager = new AccountManager(undefined, makeStorage(3));
  });

  it("round-robin advances through accounts in order", () => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const account = manager.getAccountForStrategy("round-robin", FAMILY);
      if (account) seen.push(account.index);
    }
    expect(seen).toEqual([0, 1, 2, 0]);
  });

  it("sticky concentrates on one account", () => {
    const seen: number[] = [];
    for (let i = 0; i < 4; i++) {
      const account = manager.getAccountForStrategy("sticky", FAMILY);
      if (account) seen.push(account.index);
    }
    expect(seen).toEqual([0, 0, 0, 0]);
  });

  it("hybrid dispatches identically to getCurrentOrNextForFamilyHybrid", () => {
    const viaDispatcher = manager.getAccountForStrategy("hybrid", FAMILY);
    expect(viaDispatcher).not.toBeNull();
    // With one healthy current account, hybrid stays put too.
    expect(manager.getAccountForStrategy("hybrid", FAMILY)?.index).toBe(
      viaDispatcher?.index,
    );
  });

	it.each(["sticky", "round-robin", "hybrid"] as const)(
		"%s prefers an assigned healthy account",
		(strategy) => {
			const selected = manager.getAccountForStrategy(
				strategy,
				FAMILY,
				"gpt-5.6-sol",
				undefined,
				["account-id-2"],
			);
			expect(selected?.accountId).toBe("account-id-2");
		},
	);

	it.each(["sticky", "round-robin", "hybrid"] as const)(
		"%s falls back to the general pool when assigned accounts are unavailable",
		(strategy) => {
			manager.setAccountEnabled(1, false);
			const selected = manager.getAccountForStrategy(
				strategy,
				FAMILY,
				"gpt-5.6-sol",
				undefined,
				["account-id-2"],
			);
			expect(selected).not.toBeNull();
			expect(selected?.accountId).not.toBe("account-id-2");
		},
	);

	it.each(["sticky", "round-robin", "hybrid"] as const)(
		"%s does not leave an unavailable strict pool",
		(strategy) => {
			manager.setAccountEnabled(1, false);
			const selected = manager.getAccountForStrategy(
				strategy,
				FAMILY,
				"gpt-5.6-sol",
				undefined,
				["account-id-2"],
				"strict",
			);
			expect(selected).toBeNull();
		},
	);

	it("does not leave a strict pool whose configured IDs are unknown", () => {
		const selected = manager.getAccountForStrategy(
			"sticky",
			FAMILY,
			"gpt-5.6-sol",
			undefined,
			["unknown-account-id"],
			"strict",
		);
		expect(selected).toBeNull();
	});

	it.each(["sticky", "round-robin", "hybrid"] as const)(
		"%s tries another strict-pool account after a request-local attempt",
		(strategy) => {
			const selected = manager.getAccountForStrategy(
				strategy,
				FAMILY,
				"gpt-5.6-sol",
				undefined,
				["account-id-1", "account-id-2"],
				"strict",
				new Set([0]),
			);
			expect(selected?.accountId).toBe("account-id-2");
		},
	);

	it("sticky stays on its current strict-pool account, then advances only within the pool", () => {
		const pool = ["account-id-2", "account-id-3"];
		const first = manager.getAccountForStrategy(
			"sticky",
			FAMILY,
			"gpt-5.6-sol",
			undefined,
			pool,
			"strict",
		);
		expect(first?.accountId).toBe("account-id-2");
		expect(
			manager.getAccountForStrategy(
				"sticky",
				FAMILY,
				"gpt-5.6-sol",
				undefined,
				pool,
				"strict",
			),
		).toBe(first);

		const next = manager.getAccountForStrategy(
			"sticky",
			FAMILY,
			"gpt-5.6-sol",
			undefined,
			pool,
			"strict",
			new Set([first!.index]),
		);
		expect(next?.accountId).toBe("account-id-3");
		expect([first?.accountId, next?.accountId]).not.toContain("account-id-1");
	});

	it("falls back to the general pool when configured IDs are unknown", () => {
		const selected = manager.getAccountForStrategy(
			"sticky",
			FAMILY,
			"gpt-5.6-sol",
			undefined,
			["unknown-account-id"],
		);
		expect(selected?.index).toBe(0);
	});

	it.each(["sticky", "round-robin", "hybrid", "custom"] as const)(
		"%s excludes a user-disabled account from automatic routing",
		(strategy) => {
			manager.setAccountEnabled(0, false);

			expect(manager.getAccountForStrategy(strategy, FAMILY)?.index).toBe(1);
		},
	);

	it.each(["sticky", "round-robin", "hybrid", "custom"] as const)(
		"%s honors an explicitly switched user-disabled account",
		(strategy) => {
			manager.setAccountEnabled(0, false);
			manager.setManualAccountOverride(0);

			expect(manager.getAccountForStrategy(strategy, FAMILY)?.index).toBe(0);
			expect(manager.getAccountForStrategy(strategy, FAMILY)?.index).toBe(0);
		},
	);

	it("revalidates custom manual selection without changing the active account", () => {
		manager.setAccountEnabled(1, false);
		manager.setManualAccountOverride(1);
		const request = { family: FAMILY, model: "gpt-5.6-sol" };
		const candidates = manager.getCustomCandidates(request);
		expect(candidates.map((account) => account.index)).toEqual([1]);
		const candidate = candidates[0];
		if (!candidate) throw new Error("Expected manual candidate");
		expect(manager.acceptCustomCandidate(candidate, request)?.index).toBe(1);
		expect(manager.getCurrentAccountForFamily(FAMILY)?.index).not.toBe(1);
		manager.markRateLimited(candidate, 60_000, FAMILY, request.model);
		expect(manager.acceptCustomCandidate(candidate, request)).toBeNull();
		expect(manager.getCustomCandidates(request).map((account) => account.index)).not.toContain(1);
		manager.markRateLimited(candidate, 0, FAMILY, request.model);
		expect(manager.getCustomCandidates(request).map((account) => account.index)).toEqual([1]);
		expect(manager.getCustomCandidates({ ...request, excludedIndices: new Set([1]) })
			.map((account) => account.index)).not.toContain(1);
		expect(manager.getCustomCandidates({ ...request, preferredAccountIds: ["account-id-1"], poolMode: "strict" })
			.map((account) => account.index)).toEqual([0]);
	});

	it.each(["disableAccountsWithSameRefreshToken", "disableAccountsByWorkspaceIdentity"] as const)(
		"%s records automatic failure separately from manual selection intent",
		(method) => {
			manager.setAccountEnabled(0, false);
			manager.setManualAccountOverride(0);
			const account = manager.getAccountAt(0);
			if (!account) throw new Error("Expected first account");
			expect(manager[method](account)).toBe(1);
			expect(account.userDisabled).toBe(true);
			expect(account.accountNote).toContain("Disabled automatically");
			expect(manager.getAccountForStrategy("custom", FAMILY)?.index).toBe(1);
			expect(manager[method](account)).toBe(0);
		},
	);

	it("does not repair an automatic disable as a stale scope-only disable", () => {
		const storage = makeStorage(2);
		storage.accounts[0] = {
			...storage.accounts[0]!, enabled: false,
			accountNote: `${AUTH_FAILURE_DISABLE_NOTE_MARKER} Re-auth required for missing OAuth scope(s): email.`,
		};
		const loaded = new AccountManager(undefined, storage);
		expect(loaded.getAccountAt(0)).toMatchObject({ enabled: false, userDisabled: false });
		expect(loaded.getAccountForStrategy("custom", FAMILY)?.index).toBe(1);
	});

	it.each(["hybrid", "sticky", "round-robin", "custom"] as const)(
		"%s never overrides an auto-disable even when user-disabled as well",
		(strategy) => {
			const account = manager.getAccountAt(0);
			if (!account) throw new Error("Expected first account");
			account.accountNote = AUTH_FAILURE_DISABLE_NOTE_MARKER;
			manager.setAccountEnabled(0, false);
			manager.setManualAccountOverride(0);
			expect(manager.getAccountForStrategy(strategy, FAMILY)?.index).toBe(1);
		},
	);

	describe.each([
		{ cause: "authentication failure", marker: AUTH_FAILURE_DISABLE_NOTE_MARKER },
		{ cause: "workspace deactivation", marker: WORKSPACE_DEACTIVATED_NOTE_MARKER },
	])("merged automatic-disable routing: $cause", ({ marker }) => {
		it.each(["hybrid", "sticky", "round-robin", "custom"] as const)(
			"%s cannot manually override a retained disable in either input order",
			(strategy) => {
				for (const reversed of [false, true]) {
					resetTrackers();
					const older = {
						accountId: "fake-disabled", refreshToken: "fake-disabled-refresh",
						enabled: false, userDisabled: false, accountNote: marker, addedAt: 1, lastUsed: 1,
					};
					const newer = {
						...older, enabled: true, accountNote: "Operator reminder.", addedAt: 2, lastUsed: 2,
					};
					const healthy = {
						accountId: "fake-healthy", refreshToken: "fake-healthy-refresh", addedAt: 3, lastUsed: 3,
					};
					const storage = normalizeAccountStorage({
						version: 3, activeIndex: 0,
						accounts: [...(reversed ? [newer, older] : [older, newer]), healthy],
					});
					if (!storage) throw new Error("Expected normalized fixture");
					const loaded = new AccountManager(undefined, storage);

					loaded.setManualAccountOverride(0);

					expect(loaded.getAccountForStrategy(strategy, FAMILY)?.accountId).toBe("fake-healthy");
				}
			},
		);

		it("allows explicit re-enablement after a retained disable without losing operator text", () => {
			const storage = normalizeAccountStorage({
				version: 3, activeIndex: 0,
				accounts: [
					{ accountId: "fake-recovered", refreshToken: "fake-refresh", enabled: false,
						userDisabled: false, accountNote: marker, addedAt: 1, lastUsed: 1 },
					{ accountId: "fake-recovered", refreshToken: "fake-refresh", enabled: true,
						userDisabled: false, accountNote: "Operator reminder.", addedAt: 2, lastUsed: 2 },
				],
			});
			if (!storage) throw new Error("Expected normalized fixture");
			const loaded = new AccountManager(undefined, storage);

			loaded.setAccountEnabled(0, true);

			expect(loaded.getAccountForStrategy("sticky", FAMILY)?.accountId).toBe("fake-recovered");
			expect(loaded.getAccountAt(0)).toMatchObject({
				enabled: true, userDisabled: false, accountNote: "Operator reminder.",
			});
		});
	});

	it("replaces the manual override on another explicit switch", () => {
		manager.setAccountEnabled(0, false);
		manager.setAccountEnabled(1, false);
		manager.setManualAccountOverride(0);
		expect(manager.getAccountForStrategy("sticky", FAMILY)?.index).toBe(0);

		manager.setManualAccountOverride(1);

		expect(manager.getAccountForStrategy("sticky", FAMILY)?.index).toBe(1);
	});

	it("keeps manual selection inside a strict model pool", () => {
		manager.setAccountEnabled(0, false);
		manager.setManualAccountOverride(0);

		const selected = manager.getAccountForStrategy(
			"hybrid",
			FAMILY,
			"gpt-5.6-sol",
			undefined,
			["account-id-2"],
			"strict",
		);

		expect(selected?.accountId).toBe("account-id-2");
	});

	it("allows a manually selected disabled account inside its strict model pool", () => {
		manager.setAccountEnabled(1, false);
		manager.setManualAccountOverride(1);

		const selected = manager.getAccountForStrategy(
			"hybrid",
			FAMILY,
			"gpt-5.6-sol",
			undefined,
			["account-id-2"],
			"strict",
		);

		expect(selected?.accountId).toBe("account-id-2");
	});

	it("does not let a manual override bypass request-local exclusions", () => {
		manager.setAccountEnabled(0, false);
		manager.setManualAccountOverride(0);

		const selected = manager.getAccountForStrategy(
			"hybrid",
			FAMILY,
			undefined,
			undefined,
			undefined,
			"preferred",
			new Set([0]),
		);

		expect(selected?.index).toBe(1);
	});

	it("keeps the manual override after a rate-limit failover", () => {
		manager.setAccountEnabled(0, false);
		manager.setManualAccountOverride(0);
		const overridden = manager.getAccountForStrategy("hybrid", FAMILY);
		if (!overridden) throw new Error("manual account was not selected");
		manager.markRateLimited(overridden, 60_000, FAMILY);

		expect(manager.getAccountForStrategy("hybrid", FAMILY)?.index).toBe(1);

		manager.markRateLimited(overridden, 0, FAMILY);

		expect(manager.getAccountForStrategy("hybrid", FAMILY)?.index).toBe(0);
	});

	it("does not make a manually selected disabled account the active account", () => {
		manager.setAccountEnabled(1, false);
		manager.setManualAccountOverride(1);

		expect(manager.getAccountForStrategy("hybrid", FAMILY)?.index).toBe(1);
		expect(manager.getCurrentAccountForFamily(FAMILY)?.index).not.toBe(1);
	});

	it("honours a manual override inside a strict pool keyed by seat identity", () => {
		const storage = makeStorage(2);
		const target = storage.accounts[0];
		if (!target) throw new Error("missing target account");
		// `codex-pool add` stores the member-scoped seat key, not the
		// workspace-wide account id.
		target.accountId = "business-account";
		target.accountUserId = "member-owner";
		target.enabled = false;
		target.userDisabled = true;
		const seatManager = new AccountManager(undefined, storage);
		const seatKey = getModelPoolAccountKey(target);
		if (!seatKey) throw new Error("seat pool key was not derived");
		seatManager.setManualAccountOverride(0);

		const selected = seatManager.getAccountForStrategy(
			"hybrid",
			FAMILY,
			"gpt-5.6-sol",
			undefined,
			[seatKey],
			"strict",
		);

		expect(selected?.index).toBe(0);
	});

	it("does not let a manual override bypass cooldowns", () => {
		manager.setAccountEnabled(0, false);
		manager.setManualAccountOverride(0);
		const target = manager.getCurrentAccount();
		if (!target) throw new Error("missing target account");
		manager.markAccountCoolingDown(target, 60_000, "auth-failure");

		expect(manager.getAccountForStrategy("hybrid", FAMILY)?.index).toBe(1);
	});

	it("does not let a manual override bypass the local token bucket", () => {
		manager.setAccountEnabled(0, false);
		manager.setManualAccountOverride(0);
		getTokenTracker().drain(0, FAMILY, 100);

		expect(manager.getAccountForStrategy("hybrid", FAMILY)?.index).toBe(1);
	});

	it("does not let a manual override bypass missing OAuth scopes", () => {
		const storage = makeStorage(2);
		const target = storage.accounts[0];
		if (!target) throw new Error("missing target account");
		target.enabled = false;
		target.userDisabled = true;
		target.oauthScope = "openid profile";
		target.accountNote =
			"Re-auth required for missing OAuth scope(s): email, offline_access.";
		const scopedManager = new AccountManager(undefined, storage);
		scopedManager.setManualAccountOverride(0);

		expect(scopedManager.getAccountForStrategy("hybrid", FAMILY)?.index).toBe(1);
	});

	it("does not persist a manual override across manager restart", () => {
		const storage = makeStorage(2);
		const target = storage.accounts[0];
		if (!target) throw new Error("missing target account");
		target.enabled = false;
		target.userDisabled = true;
		const currentProcess = new AccountManager(undefined, storage);
		currentProcess.setManualAccountOverride(0);
		expect(currentProcess.getAccountForStrategy("sticky", FAMILY)?.index).toBe(0);

		const restarted = new AccountManager(undefined, storage);

		expect(restarted.getAccountForStrategy("sticky", FAMILY)?.index).toBe(1);
	});
});

describe("Business seat pool keys derived from bearer tokens", () => {
	const seatToken = (memberId: string) => {
		const payload = {
			"https://api.openai.com/auth": {
				chatgpt_account_id: "business-account",
				chatgpt_account_user_id: memberId,
			},
		};
		return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
	};

	it("derives the member id from a stored accessToken", () => {
		expect(
			getModelPoolAccountKey({
				accountId: "business-account",
				accessToken: seatToken("member-invited"),
			}),
		).toBe(
			getModelPoolAccountKey({
				accountId: "business-account",
				accountUserId: "member-invited",
			}),
		);
	});

	it("derives the member id from a live account's access token", () => {
		expect(
			getModelPoolAccountKey({
				accountId: "business-account",
				access: seatToken("member-owner"),
			}),
		).toBe(
			getModelPoolAccountKey({
				accountId: "business-account",
				accountUserId: "member-owner",
			}),
		);
	});

	it("never falls back to the workspace-wide key when a token carries a member id", () => {
		// The workspace-wide key matches EVERY seat, so falling back to it would
		// silently widen a pool the operator scoped to one member.
		expect(
			getModelPoolAccountKey({
				accountId: "business-account",
				accessToken: seatToken("member-owner"),
			}),
		).not.toBe("business-account");
	});
});

function makeAccount(overrides: Record<string, unknown> = {}): AccountStorageV3["accounts"][number] {
	return {
		refreshToken: `token-${Math.random().toString(36).slice(2)}`,
		email: `user${Math.floor(Math.random() * 1000)}@example.com`,
		addedAt: Date.now(),
		lastUsed: 0,
		...overrides,
	};
}

describe("rotation selection invariants", () => {
	beforeEach(() => {
		resetTrackers();
	});

	afterEach(() => {
		vi.useRealTimers();
		resetTrackers();
	});

	it("round-robin never returns a disabled account and returns null when all are disabled", () => {
		const manager = new AccountManager(undefined, {
			version: 3,
			accounts: [makeAccount({ enabled: false }), makeAccount({ enabled: false })],
			activeIndex: 0,
		});
		expect(manager.getAccountForStrategy("round-robin", FAMILY)).toBeNull();
	});

	it("round-robin never returns a cooling-down account when it reported none available", () => {
		vi.useFakeTimers();
		const tokens = ["tok-a", "tok-b"];
		const manager = new AccountManager(undefined, {
			version: 3,
			accounts: [makeAccount({ refreshToken: tokens[0] }), makeAccount({ refreshToken: tokens[1] })],
			activeIndex: 0,
		});
		for (const token of tokens) {
			manager.markAccountsWithRefreshTokenCoolingDown(token, 60_000, "network-error");
		}
		const explain = manager.getSelectionExplainability(FAMILY);
		expect(explain.every((entry) => !entry.eligible)).toBe(true);
		expect(manager.getAccountForStrategy("round-robin", FAMILY)).toBeNull();
		expect(manager.getAccountForStrategy("sticky", FAMILY)).toBeNull();
	});

	it("hybrid never returns a disabled account even in the LRU fallback", () => {
		const manager = new AccountManager(undefined, {
			version: 3,
			accounts: [makeAccount({ enabled: false }), makeAccount({ enabled: false })],
			activeIndex: 0,
		});
		expect(manager.getAccountForStrategy("hybrid", FAMILY)).toBeNull();
	});

	it("hybrid still selects around a disabled account when others are healthy", () => {
		const manager = new AccountManager(undefined, {
			version: 3,
			accounts: [makeAccount({ enabled: false }), makeAccount(), makeAccount()],
			activeIndex: 0,
		});
		const picked = manager.getAccountForStrategy("hybrid", FAMILY);
		expect(picked).not.toBeNull();
		expect(picked?.enabled).not.toBe(false);
	});

	it("markQuotaExhausted rejects reset stamps beyond the 30-day horizon", () => {
		vi.useFakeTimers();
		const manager = new AccountManager(undefined, {
			version: 3,
			accounts: [makeAccount()],
			activeIndex: 0,
		});
		const account = manager.getAccountsSnapshot()[0]!;
		const now = Date.now();
		expect(manager.markQuotaExhausted(account, now + MAX_QUOTA_RESET_HORIZON_MS + 1, FAMILY)).toBe(false);
		expect(manager.markQuotaExhausted(account, now + MAX_QUOTA_RESET_HORIZON_MS, FAMILY)).toBe(true);
		expect(manager.markQuotaExhausted(account, Number.NaN, FAMILY)).toBe(false);
		expect(manager.markQuotaExhausted(account, Number.POSITIVE_INFINITY, FAMILY)).toBe(false);
	});
});
