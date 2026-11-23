/**
 * Shared parser for the per-window quota headers the Codex backend puts on
 * every response (`x-codex-primary-*` = the rolling ~5h window,
 * `x-codex-secondary-*` = the weekly window).
 *
 * These headers were previously only read for the TUI status line
 * (`lib/tui-quota-cache.ts`), so the rotation layer had no idea an account had
 * spent its weekly quota until the backend 429'd — and even then it could not
 * tell *which* window was spent. Issue #218: an account at 0% weekly was picked
 * again on every prompt, failed, and rotated away, forever.
 *
 * This module is deliberately a leaf (no imports): both the request path and
 * the TUI cache depend on it, and it must not drag either into the other.
 */

export type CodexQuotaWindowKind = "primary" | "secondary";

interface LabeledQuotaWindow {
	readonly label: string;
	readonly windowMinutes?: number;
}

export function isFiveHourQuotaWindow({ label, windowMinutes }: LabeledQuotaWindow): boolean {
	return windowMinutes === 300 || /^5h$/i.test(label);
}

export function isWeeklyQuotaWindow({ label, windowMinutes }: LabeledQuotaWindow): boolean {
	return windowMinutes === 10_080 || /^(weekly|7d)$/i.test(label);
}

export interface CodexQuotaWindow {
	kind: CodexQuotaWindowKind;
	/** 0-100. Values >= 100 mean the window is spent. */
	usedPercent?: number;
	/** Window length in minutes. An explicit `0` means "disabled for this plan". */
	windowMinutes?: number;
	/** Absolute reset time in ms since epoch. */
	resetAtMs?: number;
}

export const CODEX_QUOTA_WINDOW_KINDS: readonly CodexQuotaWindowKind[] = [
	"primary",
	"secondary",
];

export const CODEX_QUOTA_HEADER_PREFIXES: Record<CodexQuotaWindowKind, string> = {
	primary: "x-codex-primary",
	secondary: "x-codex-secondary",
};

const QUOTA_HEADER_SUFFIXES = [
	"-used-percent",
	"-window-minutes",
	"-reset-at",
	"-reset-after-seconds",
] as const;

/** Epoch values below this are seconds, above are milliseconds. */
const EPOCH_SECONDS_CEILING = 10_000_000_000;

/**
 * The furthest ahead a reset time can be and still be believable.
 *
 * The longest window Codex has is the weekly one, so anything past a month is
 * not a quota reset — it is a garbled header, a wrong-unit value, or a gateway
 * inventing a number. Believing it is not a small error: the reset is written
 * into the persisted `rateLimitResetTimes` map through a deliberately monotonic
 * writer, so a single bogus header takes the account out of rotation for as
 * long as it claims (measured: `-reset-after-seconds: 4000000000` = 127 years)
 * and nothing in the product can shorten it again.
 */
export const MAX_QUOTA_RESET_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Reject a reset time that cannot be real.
 *
 * Rejecting rather than clamping is the safe direction: an implausible header
 * tells us nothing about when the account recovers, and "no usable reset time"
 * leaves the account selectable so the next request rediscovers the truth. A
 * clamp would still write a month-long block on the strength of a garbled
 * value.
 */
function withinResetHorizon(
	resetAtMs: number,
	now: number,
): number | undefined {
	if (!Number.isFinite(resetAtMs)) return undefined;
	if (resetAtMs - now > MAX_QUOTA_RESET_HORIZON_MS) return undefined;
	return resetAtMs;
}

function parseFiniteNumberHeader(
	headers: Headers,
	name: string,
): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFiniteIntHeader(headers: Headers, name: string): number | undefined {
	const raw = headers.get(name);
	if (!raw) return undefined;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Resolve a window's absolute reset time.
 *
 * `-reset-after-seconds` is preferred over `-reset-at` because it is immune to
 * clock skew between this host and the backend. `-reset-at` is accepted both as
 * an epoch stamp (seconds or milliseconds) and as an ISO-8601 date string.
 *
 * Every branch returns through {@link withinResetHorizon}: this is the one
 * choke point all three header forms pass through, so bounding it here is what
 * keeps an implausible value out of both the durable rotation block and the
 * retry-after delay derived from the same headers.
 */
export function parseQuotaResetAtMs(
	headers: Headers,
	prefix: string,
	now: number = Date.now(),
): number | undefined {
	const resetAfterSeconds = parseFiniteIntHeader(
		headers,
		`${prefix}-reset-after-seconds`,
	);
	if (typeof resetAfterSeconds === "number" && resetAfterSeconds > 0) {
		return withinResetHorizon(now + resetAfterSeconds * 1000, now);
	}

	const resetAtRaw = headers.get(`${prefix}-reset-at`);
	if (!resetAtRaw) return undefined;
	const trimmed = resetAtRaw.trim();
	if (/^\d+$/.test(trimmed)) {
		const parsed = Number.parseInt(trimmed, 10);
		if (Number.isFinite(parsed) && parsed > 0) {
			return withinResetHorizon(
				parsed < EPOCH_SECONDS_CEILING ? parsed * 1000 : parsed,
				now,
			);
		}
		return undefined;
	}

	const parsedDate = Date.parse(trimmed);
	return Number.isFinite(parsedDate)
		? withinResetHorizon(parsedDate, now)
		: undefined;
}

export function hasCodexQuotaHeaders(headers: Headers): boolean {
	return CODEX_QUOTA_WINDOW_KINDS.some((kind) =>
		QUOTA_HEADER_SUFFIXES.some(
			(suffix) =>
				headers.get(`${CODEX_QUOTA_HEADER_PREFIXES[kind]}${suffix}`) !== null,
		),
	);
}

export function parseCodexQuotaWindow(
	headers: Headers,
	kind: CodexQuotaWindowKind,
	now: number = Date.now(),
): CodexQuotaWindow {
	const prefix = CODEX_QUOTA_HEADER_PREFIXES[kind];
	return {
		kind,
		usedPercent: parseFiniteNumberHeader(headers, `${prefix}-used-percent`),
		windowMinutes: parseFiniteIntHeader(headers, `${prefix}-window-minutes`),
		resetAtMs: parseQuotaResetAtMs(headers, prefix, now),
	};
}

/**
 * Parse every quota window the response describes. Windows with no headers at
 * all are omitted, so an empty array means the backend reported no quota state.
 */
export function parseCodexQuotaWindows(
	headers: Headers,
	now: number = Date.now(),
): CodexQuotaWindow[] {
	return CODEX_QUOTA_WINDOW_KINDS.map((kind) =>
		parseCodexQuotaWindow(headers, kind, now),
	).filter(hasQuotaWindowData);
}

function hasQuotaWindowData(window: CodexQuotaWindow): boolean {
	return (
		typeof window.usedPercent === "number" ||
		typeof window.windowMinutes === "number" ||
		typeof window.resetAtMs === "number"
	);
}

/**
 * A window reported with `window-minutes: 0` is switched off for the plan, not
 * a window of unknown length. It still reports a used-percent, so it has to be
 * rejected on the explicit zero rather than on missing data.
 */
export function isQuotaWindowDisabled(
	window: Pick<CodexQuotaWindow, "windowMinutes">,
): boolean {
	return window.windowMinutes === 0;
}

export function isQuotaWindowExhausted(
	window: Pick<CodexQuotaWindow, "windowMinutes" | "usedPercent">,
): boolean {
	if (isQuotaWindowDisabled(window)) return false;
	return typeof window.usedPercent === "number" && window.usedPercent >= 100;
}

/**
 * The instant at which every spent window has reset, or `undefined` when no
 * window is spent (or the backend gave no usable reset time).
 *
 * The *latest* reset wins, not the soonest: an account whose weekly window is
 * gone stays unusable even after its 5h window rolls over, so collapsing the
 * two with `Math.min` is what let issue #218's account back into rotation every
 * five hours.
 */
export function getQuotaExhaustedResetAtMs(
	headers: Headers,
	now: number = Date.now(),
): number | undefined {
	let latest: number | undefined;
	for (const window of parseCodexQuotaWindows(headers, now)) {
		if (!isQuotaWindowExhausted(window)) continue;
		const resetAtMs = window.resetAtMs;
		if (typeof resetAtMs !== "number" || resetAtMs <= now) continue;
		if (latest === undefined || resetAtMs > latest) latest = resetAtMs;
	}
	return latest;
}
