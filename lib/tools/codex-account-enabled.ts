/** `codex-account-enabled` tool — persist automatic-routing eligibility. */

import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import { hasAutoDisableNote, isPersistedUserDisabled } from "../accounts/state.js";
import { logWarn } from "../logger.js";
import { getWorkspaceIdentityKey, loadAccounts, withAccountStorageTransaction } from "../storage.js";
import type { ToolContext } from "./index.js";
import { rethrowIfRetryable, withToolErrorEnvelope } from "./output.js";

const REAUTH_NOTE_MARKER = "Re-auth required for missing OAuth scope(s):";

export function createCodexAccountEnabledTool(ctx: ToolContext): ToolDefinition {
	const {
		formatCommandAccountLabel,
		manualAccountOverrideIdentityRef,
		promptAccountIndexSelection,
		withAccountManagerMutation,
		resolveMaskEmail,
		resolveUiRuntime,
		supportsInteractiveMenus,
	} = ctx;
	const definition = tool({
		description:
			"Enable or disable a saved Codex account for automatic routing by 1-based index.",
		args: {
			index: tool.schema
				.number()
				.optional()
				.describe("Account number to update (1-based, e.g. 1 for first account)"),
			enabled: tool.schema
				.boolean()
				.describe("Whether automatic routing may select this account."),
		},
		async execute({ index, enabled }: { index?: number; enabled: boolean }): Promise<string> {
			const ui = resolveUiRuntime();
			const initialStorage = await loadAccounts();
			if (!initialStorage || initialStorage.accounts.length === 0) {
				return "No Codex accounts configured. Run: opencode auth login";
			}

			let resolvedIndex = index;
			if (resolvedIndex === undefined) {
				const selected = await promptAccountIndexSelection(
					ui,
					initialStorage,
					enabled ? "Enable account" : "Disable account",
				);
				if (selected === null) {
					return supportsInteractiveMenus()
						? "No account selected."
						: "Missing account number. Use: codex-account-enabled index=1 enabled=false";
				}
				resolvedIndex = selected + 1;
			}

			type EnablementOutcome =
				| { kind: "invalid"; accountCount: number }
				| { kind: "save-failed"; label: string }
				| { kind: "unchanged"; label: string; targetIdentity: string }
				| { kind: "ok"; label: string; targetIdentity: string };
			const outcome = await withAccountManagerMutation(
				async () => {
					const result = await withAccountStorageTransaction<EnablementOutcome>(async (current, persist) => {
					const targetIndex = (resolvedIndex ?? 0) - 1;
					const account = current?.accounts[targetIndex];
					if (
						!current ||
						!Number.isInteger(targetIndex) ||
						targetIndex < 0 ||
						!account
					) {
						return {
							kind: "invalid",
							accountCount: current?.accounts.length ?? 0,
						};
					}
					const label = formatCommandAccountLabel(account, targetIndex, {
						maskEmail: resolveMaskEmail(),
					});
					if (isPersistedUserDisabled(account) === !enabled) {
						return { kind: "unchanged", label, targetIdentity: getWorkspaceIdentityKey(account) };
					}

					if (enabled) {
						delete account.userDisabled;
						if (!hasAutoDisableNote(account.accountNote) && !account.accountNote?.includes(REAUTH_NOTE_MARKER)) {
							delete account.enabled;
						}
					} else {
						account.userDisabled = true;
						account.enabled = false;
					}
					try {
						await persist(current);
					} catch (error) {
						rethrowIfRetryable(error);
						logWarn("Failed to save account enablement", { error: String(error) });
						return { kind: "save-failed", label };
					}
					return { kind: "ok", label, targetIdentity: getWorkspaceIdentityKey(account) };
					});
					if (
						result.kind === "ok" &&
						manualAccountOverrideIdentityRef.current === result.targetIdentity
					) {
						manualAccountOverrideIdentityRef.current = null;
					}
					return result;
				},
				(result) => result.kind === "ok",
			);

			if (outcome.kind === "invalid") {
				return `Invalid account number: ${resolvedIndex}\n\nValid range: 1-${outcome.accountCount}`;
			}
			if (outcome.kind === "save-failed") {
				return `Failed to ${enabled ? "enable" : "disable"} ${outcome.label}: account storage could not be updated.`;
			}
			if (outcome.kind === "unchanged") {
				return `${outcome.label} is already ${enabled ? "enabled" : "disabled"}.`;
			}

			return `${enabled ? "Enabled" : "Disabled"} ${outcome.label} for automatic routing.`;
		},
	});
	return withToolErrorEnvelope("codex-account-enabled", definition);
}
