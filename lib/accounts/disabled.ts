/** Disable provenance shared by storage merges, routing, and account views. */
export const MISSING_SCOPE_NOTE_MARKER = "Re-auth required for missing OAuth scope(s):";

/** Markers distinguish plugin failures from the operator's routing preference. */
export const AUTH_FAILURE_DISABLE_NOTE_MARKER =
	"Disabled automatically after repeated authentication failures.";
export const WORKSPACE_DEACTIVATED_NOTE_MARKER =
	"Disabled automatically after workspace deactivation.";
const AUTO_DISABLE_NOTE_MARKERS = [
	AUTH_FAILURE_DISABLE_NOTE_MARKER,
	WORKSPACE_DEACTIVATED_NOTE_MARKER,
] as const;

export function hasMissingScopeReauthNote(accountNote: string | undefined): boolean {
	return typeof accountNote === "string" && accountNote.includes(MISSING_SCOPE_NOTE_MARKER);
}

export function hasAuthFailureDisableNote(accountNote: string | undefined): boolean {
	return typeof accountNote === "string" && accountNote.includes(AUTH_FAILURE_DISABLE_NOTE_MARKER);
}

export function hasAutoDisableNote(accountNote: string | undefined): boolean {
	return typeof accountNote === "string" &&
		AUTO_DISABLE_NOTE_MARKERS.some((marker) => accountNote.includes(marker));
}

export function isPersistedUserDisabled(account: {
	enabled?: boolean;
	userDisabled?: boolean;
	accountNote?: string;
}): boolean {
	return account.userDisabled ?? (account.enabled === false &&
		!hasMissingScopeReauthNote(account.accountNote) && !hasAutoDisableNote(account.accountNote));
}

/** Reason string for the selection explainability `reasons` list. */
export function describeDisabledReason(accountNote: string | undefined): string {
	if (hasAuthFailureDisableNote(accountNote)) return "disabled:auth-failures";
	if (typeof accountNote === "string" && accountNote.includes(WORKSPACE_DEACTIVATED_NOTE_MARKER)) {
		return "disabled:workspace-deactivated";
	}
	if (hasMissingScopeReauthNote(accountNote)) return "disabled:reauth-required";
	return "disabled";
}

export function appendAutoDisableNote(
	accountNote: string | undefined,
	marker: (typeof AUTO_DISABLE_NOTE_MARKERS)[number],
): string {
	const preserved = stripAutoDisableNote(accountNote);
	return preserved ? `${preserved} ${marker}` : marker;
}

/** Remove only our sentence wherever it sits, preserving surrounding operator text. */
export function stripAutoDisableNote(accountNote: string | undefined): string | undefined {
	if (!accountNote) return undefined;
	let note = accountNote;
	for (const marker of AUTO_DISABLE_NOTE_MARKERS) {
		const markerIndex = note.indexOf(marker);
		if (markerIndex < 0) continue;
		// Swallow the joining space appendAutoDisableNote inserted.
		const start = markerIndex > 0 && note[markerIndex - 1] === " " ? markerIndex - 1 : markerIndex;
		note = `${note.slice(0, start)}${note.slice(markerIndex + marker.length)}`;
	}
	const preserved = note.trim();
	return preserved.length > 0 ? preserved : undefined;
}
