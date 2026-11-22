import { describe, expect, it } from "vitest";
import { getAccountShortNames, getQuotaRefresh, getQuotaSidebar, getQuotaStatus } from "../lib/config.js";
import { PluginConfigSchema } from "../lib/schemas.js";

describe("quota forecast configuration", () => {
	it("preserves legacy defaults when options are absent", () => {
		expect(getQuotaStatus({})).toMatchObject({
			layout: "accounts", recovery: false, resetsMinUsedPercent: 100,
		});
	});

	it("accepts total layout and all recovery events when configured", () => {
		const parsed = PluginConfigSchema.parse({
			quotaStatus: { layout: "total", recovery: "all", resetsMinUsedPercent: 80 },
		});
		expect(getQuotaStatus(parsed)).toMatchObject({
			layout: "total", recovery: "all", resetsMinUsedPercent: 80,
		});
	});

	it.each([false, true, "all"] as const)("preserves recovery %s through parsing", (recovery) => {
		const parsed = PluginConfigSchema.parse({ quotaStatus: { recovery } });
		expect(getQuotaStatus(parsed).recovery).toBe(recovery);
	});

	it.each([0, 50.5, 100])("accepts reset threshold %s within the percentage range", (resetsMinUsedPercent) => {
		const parsed = PluginConfigSchema.parse({ quotaStatus: { resetsMinUsedPercent } });
		expect(getQuotaStatus(parsed).resetsMinUsedPercent).toBe(resetsMinUsedPercent);
	});

	it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY, "80"])("rejects invalid reset threshold %s", (resetsMinUsedPercent) => {
		expect(PluginConfigSchema.safeParse({ quotaStatus: { resetsMinUsedPercent } }).success).toBe(false);
	});
});

describe("configurable TUI account display", () => {
	it("defaults to compact names, native colors, and a bounded shared refresh", () => {
		const config = PluginConfigSchema.parse({});
		expect(getQuotaStatus(config)).toMatchObject({ activeAccountName: "short", accountNames: "number", color: "auto" });
		expect(getQuotaSidebar(config)).toEqual({ enabled: true, accountNames: "short", showQuota: true, showResetTimes: true, color: "default" });
		expect(getQuotaRefresh(config)).toEqual({ enabled: true, intervalMs: 600_000 });
		expect(getAccountShortNames(config)).toEqual({});
	});

	it("round-trips independent name, sidebar, color and polling preferences", () => {
		const config = PluginConfigSchema.parse({
			accountShortNames: { "FAKE_ACCOUNT": "work", "person@example.com": "personal" },
			quotaStatus: { activeAccountName: "none", accountNames: "short", color: "#aBc123" },
			quotaSidebar: { enabled: false, accountNames: "full", showQuota: false, showResetTimes: true, color: "accent" },
			quotaRefresh: { enabled: false, intervalMs: 1_800_000 },
		});
		expect(getAccountShortNames(config)).toEqual({ "FAKE_ACCOUNT": "work", "person@example.com": "personal" });
		expect(getQuotaStatus(config)).toMatchObject({ activeAccountName: "none", accountNames: "short", color: "#aBc123" });
		expect(getQuotaSidebar(config)).toEqual({ enabled: false, accountNames: "full", showQuota: false, showResetTimes: true, color: "accent" });
		expect(getQuotaRefresh(config)).toEqual({ enabled: false, intervalMs: 1_800_000 });
	});

	it.each(["auto", "default", "muted", "accent", "success", "warning", "error", "info", "#123aBC"])("accepts native color %s", (color) => {
		const config = PluginConfigSchema.parse({ quotaStatus: { color }, quotaSidebar: { color } });
		expect(getQuotaStatus(config).color).toBe(color);
		expect(getQuotaSidebar(config).color).toBe(color);
	});

	it.each(["\u001b[31m", "red", "#abc", "#ffffffff", "$text.base", { fg: "red" }, 42])("ignores invalid color %j without losing routing settings", (color) => {
		const config = PluginConfigSchema.parse({ rotationStrategy: "sticky", quotaStatus: { color }, quotaSidebar: { color } });
		expect(config.rotationStrategy).toBe("sticky");
		expect(getQuotaStatus(config).color).toBe("auto");
		expect(getQuotaSidebar(config).color).toBe("default");
	});

	it.each(["short", "full", "number", "none"])("supports %s identity mode independently", (name) => {
		const config = PluginConfigSchema.parse({ quotaStatus: { activeAccountName: name }, quotaSidebar: { accountNames: name } });
		expect(getQuotaStatus(config).activeAccountName).toBe(name);
		expect(getQuotaSidebar(config).accountNames).toBe(name);
	});

	it.each([0, 2_000, 300_000, 599_999])("clamps an attempted %sms poll to ten minutes", (intervalMs) => {
		expect(getQuotaRefresh(PluginConfigSchema.parse({ quotaRefresh: { intervalMs } })).intervalMs).toBe(600_000);
	});

	it("bounds direct caller durations and tolerates malformed alias entries", () => {
		expect(getQuotaRefresh({ quotaRefresh: { intervalMs: Infinity } }).intervalMs).toBe(600_000);
		expect(getQuotaRefresh({ quotaRefresh: { intervalMs: 100_000_000 } }).intervalMs).toBe(86_400_000);
		const parsed = PluginConfigSchema.parse({ rotationStrategy: "sticky", accountShortNames: { "FAKE_ACCOUNT": 42, "person@example.com": "home" } });
		expect(parsed.rotationStrategy).toBe("sticky");
		expect(getAccountShortNames(parsed)).toEqual({ "FAKE_ACCOUNT": "", "person@example.com": "home" });
	});
});

describe("quota status prefix", () => {
	it("defaults to no prefix and reads a configured one", () => {
		expect(getQuotaStatus(PluginConfigSchema.parse({})).prefix).toBe("");
		expect(getQuotaStatus(PluginConfigSchema.parse({ quotaStatus: { prefix: "OpenAI " } })).prefix).toBe("OpenAI ");
	});

	it.each([
		["\u001b]0;pwned\u0007Open\nAI ", "Open AI "],
		["OpenAI\t", "OpenAI "],
		["‮OpenAI", "OpenAI"],
		["\u0007", ""],
	])("strips terminal controls from %j but keeps its trailing separator", (prefix, expected) => {
		expect(getQuotaStatus(PluginConfigSchema.parse({ quotaStatus: { prefix } })).prefix).toBe(expected);
	});
});
