import { describe, expect, it } from "vitest";
import { getModelPoolAccountKey } from "../lib/accounts/pool-identity.js";
import { resolveAccountShortName, sanitizeAccountShortName } from "../lib/account-short-name.js";
import { formatPromptStatusText, type CompactQuotaStatus } from "../lib/tui-status.js";
import { formatQuotaCreditsCandidates, formatQuotaOverviewCandidates, formatQuotaResetsCandidates, resolveAccountName, type QuotaOverviewAccount } from "../lib/quota-overview.js";
import { displayWidth } from "../lib/ui/display-text.js";

describe("account short names", () => {
	const first = { accountId: "FAKE_WORKSPACE", accountUserId: "FAKE_USER_1", email: "member@example.test" };
	const second = { ...first, accountUserId: "FAKE_USER_2" };

	it("prefers a stable member seat key to a shared workspace or email", () => {
		const key = getModelPoolAccountKey(first);
		if (!key) throw new Error("missing fixture seat key");
		const aliases = { [key]: "personal", FAKE_WORKSPACE: "team", "member@example.test": "mail" };
		expect(resolveAccountShortName(first, 1, aliases)).toBe("personal");
		expect(resolveAccountShortName(first, 9, aliases)).toBe("personal");
		expect(resolveAccountShortName(second, 2, aliases)).toBe("team");
		expect(resolveAccountShortName({ email: first.email }, 1, aliases)).toBe("mail");
	});

	it("resolves an unbackfilled seat identity from the existing token without network access", () => {
		const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_user_id: "FAKE_USER_1" } })).toString("base64url");
		const account = { accountId: "FAKE_WORKSPACE", accessToken: `e30.${payload}.FAKE_SIGNATURE` };
		const key = getModelPoolAccountKey(first);
		if (!key) throw new Error("missing fixture seat key");
		expect(resolveAccountShortName(account, 2, { [key]: "work" })).toBe("work");
	});

	it("never substitutes a full identity when an alias is absent or unusable", () => {
		expect(resolveAccountShortName(first, 3)).toBe("A3");
		expect(resolveAccountShortName(first, 3, { FAKE_WORKSPACE: "[]\u001b[31m\u001b[0m" })).toBe("A3");
		expect(resolveAccountShortName({ accountId: "toString" }, 4, {})).toBe("A4");
		expect(resolveAccountShortName(first, 3, Object.create({ FAKE_WORKSPACE: "inherited" }))).toBe("A3");
	});

	it("matches email keys exactly instead of merging unrelated seats", () => {
		expect(resolveAccountShortName({ email: " Member@example.test " }, 1, { "member@example.test": "different" })).toBe("A1");
		expect(resolveAccountShortName({ email: " member@example.test " }, 1, { "member@example.test": "work" })).toBe("work");
	});

	it("sanitizes terminal controls, brackets and bidi marks", () => {
		expect(sanitizeAccountShortName(" [\u001b[31mwork\u001b[0m]\n\u202esafe ")).toBe("work safe");
		expect(sanitizeAccountShortName("\u001b]0;FAKE_TITLE\u0007[alias]")).toBe("alias");
		expect(sanitizeAccountShortName(undefined)).toBeUndefined();
		expect(sanitizeAccountShortName({})).toBeUndefined();
	});

	it("bounds Unicode aliases by display columns without cutting a grapheme", () => {
		const family = "👨‍👩‍👧‍👦";
		for (const input of ["中文".repeat(10), family.repeat(10), "e\u0301".repeat(30), "ordinary-name-is-too-long"]) {
			const result = sanitizeAccountShortName(input);
			expect(result).toBeDefined();
			expect(displayWidth(result ?? "")).toBeLessThanOrEqual(16);
		}
		expect(sanitizeAccountShortName(family.repeat(10))).toBe(family.repeat(8));
	});
});

describe("short names on status surfaces", () => {
	const quota: CompactQuotaStatus = {
		type: "ready", stale: false, limits: [{ label: "5h", leftPercent: 80 }],
		accountIndex: 1, accountCount: 1, accountEmail: "private@example.test", accountShortName: "work",
	};

	it("shows a bracketed alias even for a one-account pool", () => {
		expect(formatPromptStatusText({ quota, activeAccountName: "short", width: 100 })).toBe("[work] · 5h 80%");
	});

	it("uses safe ordinal and hidden modes independently of aliases", () => {
		expect(formatPromptStatusText({ quota, activeAccountName: "number", width: 100 })).toBe("[A1] · 5h 80%");
		expect(formatPromptStatusText({ quota, activeAccountName: "none", width: 100 })).toBe("5h 80%");
		expect(formatPromptStatusText({ quota: { ...quota, accountShortName: undefined }, activeAccountName: "short", width: 100 })).toBe("[A1] · 5h 80%");
	});

	it("retains the requested identity when quota is unavailable or loading", () => {
		expect(formatPromptStatusText({ quota: { type: "unavailable" }, activeAccountName: "short", accountHint: { index: 2, shortName: "home" }, width: 100 })).toBe("[home] · limits ?");
		expect(formatPromptStatusText({ quota: { type: "loading" }, activeAccountName: "short", accountHint: { index: 2, shortName: "home" }, width: 100 })).toBe("[home]");
	});

	it("keeps the legacy full and masked modes without using the alias", () => {
		const multiple = { ...quota, accountCount: 2 };
		expect(formatPromptStatusText({ quota: multiple, width: 120 })).toContain("[private@example.test]");
		expect(formatPromptStatusText({ quota: multiple, activeAccountName: "full", maskEmail: true, width: 120 })).toContain("[pr***@example.test]");
	});

	it("never falls back to an email when the alias does not fit", () => {
		for (const availableChars of [1, 4, 8, 12, 16, 20]) {
			const result = formatPromptStatusText({ quota: { ...quota, accountShortName: "中文".repeat(8) }, activeAccountName: "short", availableChars });
			expect(displayWidth(result)).toBeLessThanOrEqual(availableChars);
			expect(result).not.toContain("@");
		}
	});

	it.each(["short", "number"] as const)("keeps the %s account name before a reset annotation on a narrow footer", (activeAccountName) => {
		const lowQuota = { ...quota, limits: [{ label: "5h", leftPercent: 8, resetAtMs: Date.now() + 10 * 3_600_000 }] };
		const text = formatPromptStatusText({ quota: lowQuota, activeAccountName, availableChars: 22 });
		expect(text).toBe(`${activeAccountName === "short" ? "[work]" : "[A1]"} · 5h 8%`);
		expect(displayWidth(text)).toBeLessThanOrEqual(22);
	});

	it("keeps all overview, reset and credit candidate fallbacks free of full identities", () => {
		const accounts: QuotaOverviewAccount[] = [{
			index: 1, shortName: "work", email: "private@example.test", label: "Full Private Name", planType: "plus",
			windows: [{ leftPercent: 0, resetAtMs: 3_600_000 }], resetCredits: 1,
			credits: { hasCredits: true, unlimited: false, balance: 10 },
		}];
		expect(resolveAccountName(accounts[0]!, "short")).toBe("[work]");
		expect(resolveAccountName({ index: 2, windows: [] }, "short")).toBe("[A2]");
		const groups = [
			formatQuotaOverviewCandidates(accounts, { names: "short", now: 0 }),
			formatQuotaResetsCandidates(accounts, { names: "short", now: 0 }),
			formatQuotaCreditsCandidates(accounts, { names: "short" }),
		];
		for (const candidates of groups) {
			expect(candidates.some((candidate) => candidate.includes("[work]"))).toBe(true);
			for (const candidate of candidates) expect(candidate).not.toMatch(/private@|Full Private/);
		}
	});
});
