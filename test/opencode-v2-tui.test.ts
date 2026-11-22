import { afterEach, describe, expect, it, vi } from "vitest";
import type { Plugin } from "@opencode/plugin/tui";

const mocks = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));
vi.mock("@opentui/solid", () => ({
	createElement: () => ({}),
	spread: (element: object, props: object) => Object.defineProperties(element, Object.getOwnPropertyDescriptors(props)),
}));
vi.mock("solid-js", () => ({
	createSignal: <T>(initial: T) => {
		let value = initial;
		return [() => value, (next: T) => { value = next; }];
	},
	onCleanup: (cleanup: () => void) => mocks.cleanups.push(cleanup),
}));
import { setupV2Tui } from "../lib/opencode-v2-tui.js";

afterEach(() => {
	for (const cleanup of mocks.cleanups.splice(0)) cleanup();
	vi.useRealTimers();
});

function statusPayload(overrides: Record<string, unknown> = {}) {
	return {
		text: "[work] quota ready", details: "Quota details", showFor: "always", accountStorage: "global",
		accounts: [{ index: 1, label: "Work", active: true, enabled: true }],
		...overrides,
	};
}

function createHarness(response: unknown) {
	type RenderedText = { children: string; fg: string; visible?: boolean; flexShrink?: number; minWidth?: number; truncate?: boolean; wrapMode?: string };
	const slots = new Map<string, { render: (props: object) => RenderedText | null }>();
	const commands: Array<{ id: string; run: () => Promise<void> }> = [];
	const status = vi.fn().mockResolvedValue(response);
	const alert = vi.fn();
	const unregister = vi.fn();
	const theme = {
		text: {
			base: "base", muted: "muted",
			feedback: {
				success: { base: "success" }, warning: { base: "warning" },
				error: { base: "error" }, info: { base: "info" },
			},
		},
		hue: { accent: { 500: "accent" } },
	};
	const context = {
		location: { directory: "/tmp/opencode/project" }, renderer: { width: 100 },
		client: { rpc: () => ({ status }) }, theme,
		data: { session: { get: () => undefined, message: { list: () => [] } }, location: { default: () => ({ directory: "/tmp/opencode/project" }) } },
		keymap: { layer: (factory: () => { commands: typeof commands }) => commands.push(...factory().commands) },
		ui: { dialog: { alert }, slot: (claim: { append: string; render: (props: object) => RenderedText | null }) => {
			slots.set(claim.append, claim);
			return unregister;
		} },
	} as unknown as Plugin.Context;
	const dispose = setupV2Tui(context);
	slots.get("app")!.render({});
	return { slots, commands, status, alert, unregister, theme, dispose };
}

describe("V2 accounts UI", () => {
	it("exposes accounts without a mounted prompt and cleans up polling", async () => {
		vi.useFakeTimers();
		const slots = new Map<string, { render: (props: object) => { children: string } | null }>();
		const commands: Array<{ id: string; run: () => Promise<void> }> = [];
		const status = vi.fn().mockResolvedValue({
			text: "quota ready", details: "Quota details", showFor: "codex-models",
			accountStorage: "project",
			accounts: [
				{ index: 1, label: "First", active: true, enabled: true },
				{ index: 2, label: "Second", active: false, enabled: false },
			],
		});
		const alert = vi.fn();
		const unregister = vi.fn();
		const messages: Array<{ type: string; model?: { providerID: string } }> = [];
		let configuredProvider = "anthropic";
		const context = {
			location: { directory: "/tmp/opencode/project" }, renderer: { width: 100 },
			client: { rpc: () => ({ status }) }, theme: { text: { base: "white" } },
			data: { session: { get: () => ({ model: { providerID: configuredProvider } }), message: { list: () => messages } } },
			keymap: { layer: (factory: () => { commands: typeof commands }) => commands.push(...factory().commands) },
			ui: { dialog: { alert }, slot: (claim: { append: string; render: (props: object) => { children: string } | null }) => {
				slots.set(claim.append, claim);
				return unregister;
			} },
		} as unknown as Plugin.Context;
		const dispose = setupV2Tui(context);
		slots.get("app")!.render({});
		await vi.advanceTimersByTimeAsync(0);
		const sidebar = slots.get("sidebar.content")!.render({})!;
		expect(sidebar.children).toContain("● 1. First");
		expect(sidebar.children).toContain("○ 2. Second (disabled)");
		// The raw renderer width is sent — the status formatter owns the single
		// reserve discount, so subtracting it here would double-count.
		expect(status).toHaveBeenCalledWith({ width: 100 }, expect.objectContaining({ location: context.location }));
		await commands.find((command) => command.id === "codex.accounts")!.run();
		expect(alert).toHaveBeenCalledWith(expect.objectContaining({ title: "Codex accounts", message: expect.stringContaining("opencode auth login") }));
		expect(alert.mock.calls[0]?.[0].message).toContain("this project uses its own pool");
		expect(alert.mock.calls[0]?.[0].message).toContain("global pool is used to seed it");
		expect(alert.mock.calls[0]?.[0].message).toContain('"perProjectAccounts" to true (per-project) or false (global)');
		expect(alert.mock.calls[0]?.[0].message).toContain("CODEX_AUTH_PER_PROJECT_ACCOUNTS overrides this setting");
		status.mockResolvedValueOnce({
			text: "quota ready", details: "Quota details", showFor: "codex-models",
			accountStorage: "global", accounts: [
				{ index: 1, label: "First", active: true, enabled: true },
				{ index: 2, label: "Second", active: false, enabled: false },
			],
		});
		await commands.find((command) => command.id === "codex.accounts")!.run();
		expect(alert.mock.calls[1]?.[0].message).toContain("global pool is shared across projects");
		expect(alert.mock.calls[1]?.[0].message).toContain("~/.opencode/openai-codex-auth-config.json");
		expect(alert.mock.calls[1]?.[0].message).not.toContain("from this project directory");
		// Hiding Codex quota for a different provider must not hide the account list.
		expect(slots.get("prompt.footer.status")!.render({ sessionID: "test" })!.children).toBe("");
		messages.push({ type: "assistant", model: { providerID: "openai" } }, { type: "user" });
		expect(slots.get("prompt.footer.status")!.render({ sessionID: "test" })!.children).toBe("quota ready");
		configuredProvider = "openai";
		messages.push({ type: "assistant", model: { providerID: "anthropic" } });
		expect(slots.get("prompt.footer.status")!.render({ sessionID: "test" })!.children).toBe("");
		expect(sidebar.children).toContain("First");
		status.mockRejectedValue(new Error("offline"));
		await vi.advanceTimersByTimeAsync(2000);
		expect(sidebar.children).toContain("Accounts unavailable");
		await commands.find((command) => command.id === "codex.accounts")!.run();
		expect(alert.mock.calls[2]?.[0].message).toContain("Account storage: unavailable");
		expect(alert.mock.calls[2]?.[0].message).not.toContain("the global pool is shared");
		for (const cleanup of mocks.cleanups.splice(0)) cleanup();
		const calls = status.mock.calls.length;
		await vi.advanceTimersByTimeAsync(4000);
		expect(status).toHaveBeenCalledTimes(calls);
		dispose();
		expect(unregister).toHaveBeenCalledTimes(3);
	});

	it("removes stored OpenAI OAuth connections on codex.logout, keeping the pool", async () => {
		vi.useFakeTimers();
		const slots = new Map<string, { render: (props: object) => { children: string } | null }>();
		const commands: Array<{ id: string; run: () => Promise<void> }> = [];
		const status = vi.fn().mockResolvedValue({
			text: "quota ready", details: "Quota details", showFor: "always",
			accountStorage: "project", accounts: [],
		});
		const alert = vi.fn();
		const confirm = vi.fn().mockResolvedValue(true);
		const remove = vi.fn().mockResolvedValue(undefined);
		const list = vi.fn().mockResolvedValue({
			data: [
				{ id: "openai", connections: [
					{ type: "credential", id: "cred-1", label: "ChatGPT Plus", method: "oauth" },
					{ type: "credential", id: "cred-2", label: "API key", method: "key" },
					{ type: "env", name: "OPENAI_API_KEY" },
				] },
				{ id: "anthropic", connections: [{ type: "credential", id: "cred-9", label: "Claude", method: "oauth" }] },
			],
		});
		const context = {
			location: { directory: "/tmp/opencode/project" }, renderer: { width: 100 },
			client: {
				rpc: () => ({ status }),
				integration: { list },
				credential: { remove },
			},
			theme: { text: { base: "white" } },
			data: { session: { get: () => undefined, message: { list: () => [] } }, location: { default: () => ({ directory: "/tmp/opencode/project" }) } },
			keymap: { layer: (factory: () => { commands: typeof commands }) => commands.push(...factory().commands) },
			ui: { dialog: { alert, confirm }, slot: (claim: { append: string }) => { slots.set(claim.append, claim as never); return vi.fn(); } },
		} as unknown as Plugin.Context;
		setupV2Tui(context);
		slots.get("app")!.render({});
		await vi.advanceTimersByTimeAsync(0);
		const logout = commands.find((command) => command.id === "codex.logout");
		expect(logout).toBeDefined();
		await logout!.run();
		expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Codex logout" }));
		// Only the openai integration's OAuth credential is removed — API-key
		// connections, other providers, and the plugin's own pool stay put.
		expect(remove).toHaveBeenCalledTimes(1);
		expect(remove).toHaveBeenCalledWith({ credentialID: "cred-1" });
		expect(alert).toHaveBeenCalledWith(expect.objectContaining({
			title: "Codex logout",
			message: expect.stringContaining("account pool is unchanged"),
		}));
	});

	it("sanitizes RPC text and account labels, and honours the returned glyph mode", async () => {
		vi.useFakeTimers();
		const slots = new Map<string, { render: (props: object) => { children: string } | null }>();
		const status = vi.fn().mockResolvedValue({
			// Escape sequences and bidi marks must not reach the renderer; the
			// newline in `text` is preserved (multi-line status is supported).
			text: "quota\x1b[31m ready\nline two\u202e",
			details: "details \x1bPq\x1b\\ here",
			showFor: "always",
			accountStorage: "global",
			glyphMode: "ascii",
			accounts: [
				{ index: 1, label: "Fi\trst", active: true, enabled: true },
				{ index: 2, label: "\x1b[7mSecond\x1b[0m", active: false, enabled: true },
			],
		});
		const context = {
			location: { directory: "/tmp/opencode/project" }, renderer: { width: 100 },
			client: { rpc: () => ({ status }) },
			theme: { text: { base: "white" } },
			data: { session: { get: () => undefined, message: { list: () => [] } }, location: { default: () => ({ directory: "/tmp/opencode/project" }) } },
			keymap: { layer: (factory: () => { commands: Array<{ id: string }> }) => void factory() },
			ui: { dialog: { alert: vi.fn(), confirm: vi.fn() }, slot: (claim: { append: string }) => { slots.set(claim.append, claim as never); return vi.fn(); } },
		} as unknown as Plugin.Context;
		setupV2Tui(context);
		slots.get("app")!.render({});
		await vi.advanceTimersByTimeAsync(0);
		const sidebar = slots.get("sidebar.content")!.render({})!;
		// ASCII glyph mode swaps ●/○ for */o, and every label is sanitized.
		expect(sidebar.children).toContain("* 1. Fi rst");
		expect(sidebar.children).toContain("o 2. Second");
		expect(sidebar.children).not.toContain("\x1b");
		expect(slots.get("prompt.footer.status")!.render({})!.children).toBe("quota ready\nline two");
	});

	it("falls back to an 80-column budget when the renderer reports no width", async () => {
		vi.useFakeTimers();
		const slots = new Map<string, { render: (props: object) => { children: string } | null }>();
		const status = vi.fn().mockResolvedValue({
			text: "quota ready", details: "d", showFor: "always",
			accountStorage: "global", accounts: [],
		});
		const context = {
			location: { directory: "/tmp/opencode/project" }, renderer: { width: 0 },
			client: { rpc: () => ({ status }) },
			theme: { text: { base: "white" } },
			data: { session: { get: () => undefined, message: { list: () => [] } }, location: { default: () => ({ directory: "/tmp/opencode/project" }) } },
			keymap: { layer: (factory: () => { commands: Array<{ id: string }> }) => void factory() },
			ui: { dialog: { alert: vi.fn(), confirm: vi.fn() }, slot: (claim: { append: string }) => { slots.set(claim.append, claim as never); return vi.fn(); } },
		} as unknown as Plugin.Context;
		setupV2Tui(context);
		slots.get("app")!.render({});
		await vi.advanceTimersByTimeAsync(0);
		expect(status).toHaveBeenCalledWith({ width: 80 }, expect.objectContaining({ location: context.location }));
	});

	it("aborts codex.logout when the user declines the confirmation", async () => {
		vi.useFakeTimers();
		const slots = new Map<string, { render: (props: object) => { children: string } | null }>();
		const commands: Array<{ id: string; run: () => Promise<void> }> = [];
		const status = vi.fn().mockResolvedValue({
			text: "quota ready", details: "Quota details", showFor: "always",
			accountStorage: "project", accounts: [],
		});
		const confirm = vi.fn().mockResolvedValue(false);
		const remove = vi.fn().mockResolvedValue(undefined);
		const context = {
			location: { directory: "/tmp/opencode/project" }, renderer: { width: 100 },
			client: {
				rpc: () => ({ status }),
				integration: { list: vi.fn().mockResolvedValue({ data: [{ id: "openai", connections: [{ type: "credential", id: "cred-1", label: "x", method: "oauth" }] }] }) },
				credential: { remove },
			},
			theme: { text: { base: "white" } },
			data: { session: { get: () => undefined, message: { list: () => [] } }, location: { default: () => ({ directory: "/tmp/opencode/project" }) } },
			keymap: { layer: (factory: () => { commands: typeof commands }) => commands.push(...factory().commands) },
			ui: { dialog: { alert: vi.fn(), confirm }, slot: (claim: { append: string }) => { slots.set(claim.append, claim as never); return vi.fn(); } },
		} as unknown as Plugin.Context;
		setupV2Tui(context);
		slots.get("app")!.render({});
		await vi.advanceTimersByTimeAsync(0);
		await commands.find((command) => command.id === "codex.logout")!.run();
		expect(remove).not.toHaveBeenCalled();
	});

	it("uses native theme colors reactively and accepts validated RGB overrides", async () => {
		vi.useFakeTimers();
		const harness = createHarness(statusPayload({
			statusColor: "auto", statusTone: "warning",
			sidebar: { enabled: true, showQuota: true, showResetTimes: true, color: "accent" },
		}));
		await vi.advanceTimersByTimeAsync(0);
		const footer = harness.slots.get("prompt.footer.status")!.render({})!;
		const sidebar = harness.slots.get("sidebar.content")!.render({})!;
		expect(footer.fg).toBe("warning");
		expect(sidebar.fg).toBe("accent");
		expect(footer).toMatchObject({ flexShrink: 1, minWidth: 0, truncate: true, wrapMode: "none" });
		harness.theme.text.feedback.warning.base = "new-warning";
		harness.theme.hue.accent[500] = "new-accent";
		expect(footer.fg).toBe("new-warning");
		expect(sidebar.fg).toBe("new-accent");
		harness.status.mockResolvedValue(statusPayload({
			statusColor: "#A1b2C3", statusTone: "danger",
			sidebar: { enabled: true, showQuota: false, showResetTimes: false, color: "#123456" },
		}));
		await vi.advanceTimersByTimeAsync(2000);
		expect(footer.fg).toBe("#A1b2C3");
		expect(sidebar.fg).toBe("#123456");
		expect(footer.children).not.toContain("\x1b");
		expect(sidebar.children).not.toContain("\x1b");
	});

	it.each([
		["default", "normal", "base"],
		["muted", "normal", "muted"],
		["accent", "normal", "accent"],
		["success", "danger", "success"],
		["warning", "normal", "warning"],
		["error", "normal", "error"],
		["info", "normal", "info"],
		["auto", "normal", "success"],
		["auto", "warning", "warning"],
		["auto", "danger", "error"],
		["auto", "stale", "warning"],
		["auto", "unknown", "muted"],
		["\x1b[31m", "normal", "base"],
		["$text.feedback.error.base", "normal", "base"],
		["#bad", "normal", "base"],
	])("resolves color %s with tone %s to %s on both surfaces", async (color, tone, expected) => {
		vi.useFakeTimers();
		const harness = createHarness(statusPayload({
			statusColor: color, statusTone: tone,
			sidebar: { enabled: true, showQuota: false, showResetTimes: false, color },
		}));
		await vi.advanceTimersByTimeAsync(0);
		expect(harness.slots.get("prompt.footer.status")!.render({})!.fg).toBe(expected);
		expect(harness.slots.get("sidebar.content")!.render({})!.fg).toBe(expected);
	});

	it("keeps older RPC payloads name-only with the default theme color", async () => {
		vi.useFakeTimers();
		const harness = createHarness(statusPayload());
		await vi.advanceTimersByTimeAsync(0);
		const footer = harness.slots.get("prompt.footer.status")!.render({})!;
		const sidebar = harness.slots.get("sidebar.content")!.render({})!;
		expect(footer.fg).toBe("base");
		expect(sidebar.fg).toBe("base");
		expect(sidebar.visible).toBe(true);
		expect(sidebar.children).toBe("\nCodex accounts\n● 1. Work\n/codex-accounts");
	});

	it("updates quota display, independent detail toggles and sidebar visibility without adding pollers", async () => {
		vi.useFakeTimers();
		const now = Date.UTC(2026, 10, 22, 12);
		vi.setSystemTime(now);
		const accounts = [{
			index: 1, label: "Full label", displayName: "Short", active: true, enabled: true,
			quota: { stale: false, limits: [
				{ label: "5h", leftPercent: 70, resetAtMs: now + 3_600_000 },
				{ label: "weekly", leftPercent: 20, resetAtMs: now + 86_400_000 },
			] },
		}];
		const harness = createHarness(statusPayload({
			accounts, quotaDisplay: "free",
			sidebar: { enabled: true, showQuota: true, showResetTimes: true, color: "default" },
		}));
		await vi.advanceTimersByTimeAsync(0);
		const sidebar = harness.slots.get("sidebar.content")!.render({})!;
		expect(sidebar.children).toContain("1. Short");
		expect(sidebar.children).toContain("5h 70% left, resets in 1h");
		expect(sidebar.children).toContain("weekly 20% left, resets in 1d");
		harness.status.mockResolvedValue(statusPayload({
			accounts, quotaDisplay: "used",
			sidebar: { enabled: true, showQuota: true, showResetTimes: false, color: "default" },
		}));
		await vi.advanceTimersByTimeAsync(2000);
		expect(sidebar.children).toContain("5h 30% used");
		expect(sidebar.children).toContain("weekly 80% used");
		expect(sidebar.children).not.toContain("resets");
		harness.status.mockResolvedValue(statusPayload({
			accounts, quotaDisplay: "used",
			sidebar: { enabled: true, showQuota: false, showResetTimes: true, color: "default" },
		}));
		await vi.advanceTimersByTimeAsync(2000);
		expect(sidebar.children).toContain("5h resets in 59m");
		expect(sidebar.children).not.toContain("%");
		harness.status.mockResolvedValue(statusPayload({
			accounts, quotaDisplay: "used",
			sidebar: { enabled: false, showQuota: true, showResetTimes: true, color: "default" },
		}));
		await vi.advanceTimersByTimeAsync(2000);
		expect(sidebar.visible).toBe(false);
		expect(sidebar.children).toBe("");
		await harness.commands.find((command) => command.id === "codex.accounts")!.run();
		expect(harness.alert).toHaveBeenCalledWith(expect.objectContaining({
			title: "Codex accounts", message: expect.stringContaining("weekly 80% used, resets in 23h"),
		}));
		expect(vi.getTimerCount()).toBe(1);
	});

	it("counts down cached timestamps using only the existing local RPC interval", async () => {
		vi.useFakeTimers();
		const now = Date.UTC(2026, 10, 22, 12);
		vi.setSystemTime(now);
		const harness = createHarness(statusPayload({
			sidebar: { enabled: true, showQuota: true, showResetTimes: true, color: "default" },
			accounts: [{ index: 1, label: "Work", active: true, enabled: true,
				quota: { stale: true, readFailed: true, limits: [{ label: "5h", leftPercent: 0, resetAtMs: now + 3000 }] },
			}],
		}));
		await vi.advanceTimersByTimeAsync(0);
		const sidebar = harness.slots.get("sidebar.content")!.render({})!;
		harness.slots.get("prompt.footer.status")!.render({});
		expect(sidebar.children).toContain("5h 0% left, resets in 1m");
		expect(sidebar.children).toContain("stale quota; refresh failed");
		expect(harness.status).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);
		await vi.advanceTimersByTimeAsync(4000);
		expect(sidebar.children).toContain("5h 0% left, reset due");
		expect(harness.status).toHaveBeenCalledTimes(3);
	});

	it("coalesces pending polls and ignores a response after cleanup", async () => {
		vi.useFakeTimers();
		let resolveStatus = (_result: unknown) => {};
		const pending = new Promise((resolve) => { resolveStatus = resolve; });
		const harness = createHarness(pending);
		const sidebar = harness.slots.get("sidebar.content")!.render({})!;
		await vi.advanceTimersByTimeAsync(4000);
		expect(harness.status).toHaveBeenCalledTimes(1);
		const signal = harness.status.mock.calls[0]?.[1].signal as AbortSignal;
		for (const cleanup of mocks.cleanups.splice(0)) cleanup();
		expect(signal.aborted).toBe(true);
		resolveStatus(statusPayload({ sidebar: { enabled: false, showQuota: true, showResetTimes: true, color: "error" } }));
		await vi.advanceTimersByTimeAsync(4000);
		expect(sidebar.children).toContain("Loading accounts");
		expect(sidebar.visible).toBe(true);
		expect(harness.status).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
		harness.dispose();
		expect(harness.unregister).toHaveBeenCalledTimes(3);
	});
});
