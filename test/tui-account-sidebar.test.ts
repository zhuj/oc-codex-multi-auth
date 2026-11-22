import { describe, expect, it } from "vitest";
import { formatTuiAccountSidebar, type TuiSidebarAccount } from "../lib/tui-account-sidebar.js";
import { displayWidth } from "../lib/ui/display-text.js";
import { resolveUiGlyphs } from "../lib/ui/theme.js";

const NOW = Date.UTC(2026, 10, 22, 12);
const HOUR = 3_600_000;

function account(overrides: Partial<TuiSidebarAccount> = {}): TuiSidebarAccount {
	return { index: 1, label: "Work", active: true, enabled: true, ...overrides };
}

describe("cached account sidebar formatting", () => {
	it("pairs every account's percentages with the matching window's reset", () => {
		const text = formatTuiAccountSidebar([
			account({ quota: { stale: false, limits: [
				{ label: "5h", leftPercent: 73, resetAtMs: NOW + 2 * HOUR },
				{ label: "weekly", leftPercent: 40, resetAtMs: NOW + 2 * 24 * HOUR },
			] } }),
			account({ index: 2, label: "Personal", active: false, quota: { stale: false, limits: [
				{ label: "5h", leftPercent: 10, resetAtMs: NOW + 30 * 60_000 },
			] } }),
			account({ index: 3, label: "Paused", active: false, enabled: false }),
		], { showQuota: true, showResetTimes: true, now: NOW });
		expect(text).toBe([
			"● 1. Work",
			"  5h 73% left, resets in 2h",
			"  weekly 40% left, resets in 2d",
			"○ 2. Personal",
			"  5h 10% left, resets in 30m",
			"○ 3. Paused (disabled)",
			"  quota unavailable",
		].join("\n"));
	});

	it("derives used percentages from rounded remaining quota and keeps unknown values unknown", () => {
		const rows = [account({ quota: { stale: false, limits: [
			{ label: "5h", leftPercent: 87.6, usedPercent: 12.4 },
			{ label: "weekly", leftPercent: null, usedPercent: 50 },
		] } })];
		expect(formatTuiAccountSidebar(rows, { showQuota: true, quotaDisplay: "free" }))
			.toBe("● 1. Work\n  5h 88% left\n  weekly ? left");
		expect(formatTuiAccountSidebar(rows, { showQuota: true, quotaDisplay: "used" }))
			.toBe("● 1. Work\n  5h 12% used\n  weekly ? used");
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 101])("does not render invalid remaining quota %s as a valid percentage", (leftPercent) => {
		const text = formatTuiAccountSidebar([account({ quota: { stale: false, limits: [{ label: "5h", leftPercent }] } })], { showQuota: true });
		expect(text).toContain("5h ? left");
	});

	it("supports percentage and reset toggles independently", () => {
		const rows = [account({ quota: { stale: false, limits: [
			{ label: "5h", leftPercent: 20, resetAtMs: NOW + 2 * HOUR },
			{ label: "weekly", leftPercent: 100, usedPercent: 0, windowMinutes: 10080 },
		] } })];
		expect(formatTuiAccountSidebar(rows, { showQuota: true, now: NOW }))
			.toBe("● 1. Work\n  5h 20% left\n  weekly 100% left");
		expect(formatTuiAccountSidebar(rows, { showResetTimes: true, now: NOW }))
			.toBe("● 1. Work\n  5h resets in 2h");
		expect(formatTuiAccountSidebar(rows, { now: NOW })).toBe("● 1. Work");
	});

	it("shows a due reset without implying that cached quota has refilled", () => {
		const text = formatTuiAccountSidebar([account({ quota: { stale: false, limits: [
			{ label: "5h", leftPercent: 0, resetAtMs: NOW - 1 },
			{ label: "weekly", leftPercent: 10, resetAtMs: NOW },
		] } })], { showQuota: true, showResetTimes: true, now: NOW });
		expect(text).toBe("● 1. Work\n  5h 0% left, reset due\n  weekly 10% left, reset due");
	});

	it("counts down only from valid absolute timestamps, never window lengths", () => {
		const text = formatTuiAccountSidebar([account({ quota: { stale: false, limits: [
			{ label: "soon", leftPercent: 50, resetAtMs: NOW + 1 },
			...([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY].map((resetAtMs, index) => ({
				label: `missing${index}`, leftPercent: 100, windowMinutes: 300, resetAtMs,
			}))),
		] } })], { showResetTimes: true, now: NOW });
		expect(text).toBe("● 1. Work\n  soon resets in 1m");
	});

	it("labels stale and failed readings while retaining the cached percentages", () => {
		const text = formatTuiAccountSidebar([
			account({ quota: { stale: true, readFailed: true, fetchedAt: NOW - HOUR, limits: [{ label: "5h", leftPercent: 5 }] } }),
			account({ index: 2, quota: { stale: true, limits: [] } }),
			account({ index: 3, enabled: false, quota: { stale: false, readFailed: true, limits: [] } }),
		], { showQuota: true, now: NOW });
		expect(text).toContain("5h 5% left\n  stale quota; refresh failed");
		expect(text).toContain("quota unavailable\n  stale quota");
		expect(text).toContain("(disabled)\n  quota unavailable\n  refresh failed");
	});

	it("sanitizes names and window labels, prefers server display names and respects display columns", () => {
		const text = formatTuiAccountSidebar([
			account({ label: "old label", displayName: "\x1b[31mWork\x1b[0m\nteam\u202e", quota: { stale: false, limits: [
				{ label: "\x1b[7mweekly\x1b[0m\u202e", leftPercent: 25, resetAtMs: NOW + HOUR },
			] } }),
			account({ index: 2, displayName: "界".repeat(40), active: false, enabled: false }),
		], { showQuota: true, showResetTimes: true, now: NOW, glyphs: resolveUiGlyphs("ascii") });
		expect(text).toContain("* 1. Work team");
		expect(text).toContain("weekly 25% left, resets in 1h");
		expect(text).toContain("... (disabled)");
		expect(text).not.toMatch(/[\x1b\u202e]/);
		for (const line of text.split("\n")) expect(displayWidth(line)).toBeLessThanOrEqual(35);
	});

	it("keeps old payloads name-only and identifies an empty pool", () => {
		expect(formatTuiAccountSidebar([account(), account({ index: 2, active: false, enabled: false, label: "Paused" })]))
			.toBe("● 1. Work\n○ 2. Paused (disabled)");
		expect(formatTuiAccountSidebar([], { showQuota: true, showResetTimes: true })).toBe("No Codex accounts in this pool.");
	});

	it("honors an explicit empty display name without revealing the fallback label", () => {
		const text = formatTuiAccountSidebar([
			account({ displayName: "", label: "Hidden name" }),
			account({ index: 2, displayName: "", label: "Also hidden", active: false, enabled: false }),
		], { showQuota: true });
		expect(text).toBe("● 1.\n  quota unavailable\n○ 2. (disabled)\n  quota unavailable");
	});
});
