/** Display colors are resolved against the TUI client's current theme. */
export const TUI_COLOR_NAMES = [
	"auto", "default", "muted", "accent", "success", "warning", "error", "info",
] as const;

export type TuiColor = (typeof TUI_COLOR_NAMES)[number] | `#${string}`;

/** Only native theme names and opaque RGB colors may reach OpenTUI's fg prop. */
export function normalizeTuiColor(value: unknown, fallback: TuiColor = "auto"): TuiColor {
	if (typeof value !== "string") return fallback;
	const color = value.trim();
	const semantic = TUI_COLOR_NAMES.find((name) => name === color);
	if (semantic) return semantic;
	return /^#[0-9a-fA-F]{6}$/.test(color) ? color as `#${string}` : fallback;
}
