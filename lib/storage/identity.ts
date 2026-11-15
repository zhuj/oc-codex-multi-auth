/**
 * Account identity + dedup helpers.
 *
 * Split out of `lib/storage.ts` in RC-2. This module is pure and synchronous:
 * it owns the identity-key hierarchy (`organizationId` + `accountId` +
 * `accountUserId`, then `refreshToken`) and the dedup + merge rules used by `normalizeAccountStorage`
 * and the import transaction.
 *
 * The two public exports that were already re-exported from `lib/storage.ts`
 * (`deduplicateAccounts`, `deduplicateAccountsByEmail`) keep their original
 * shape so external callers can import them via either the barrel or this
 * submodule.
 */

import type { AccountMetadataV3 } from "./migrations.js";
import { extractAccountUserId } from "../auth/token-utils.js";
import {
  AUTH_FAILURE_DISABLE_NOTE_MARKER,
  WORKSPACE_DEACTIVATED_NOTE_MARKER,
  hasAutoDisableNote,
  isPersistedUserDisabled as isUserDisabled,
  stripAutoDisableNote,
} from "../accounts/disabled.js";

export type AccountLike = {
  organizationId?: string;
  accountId?: string;
  accountUserId?: string;
  accountIdSource?: AccountMetadataV3["accountIdSource"];
  accountLabel?: string;
  accountNote?: string;
  email?: string;
  refreshToken: string;
  addedAt?: number;
  lastUsed?: number;
  enabled?: boolean;
  userDisabled?: boolean;
};

const normalizeWorkspaceIdentityPart = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export function getWorkspaceIdentityKey(account: {
  organizationId?: string;
  accountId?: string;
  accountUserId?: string;
  refreshToken: string;
}): string {
  const organizationId = normalizeWorkspaceIdentityPart(account.organizationId);
  const accountId = normalizeWorkspaceIdentityPart(account.accountId);
  const accountUserId = normalizeWorkspaceIdentityPart(account.accountUserId);
  const refreshToken = normalizeWorkspaceIdentityPart(account.refreshToken) ?? "";
  if (organizationId) {
    const parts = [`organizationId:${organizationId}`];
    if (accountId) parts.push(`accountId:${accountId}`);
    if (accountUserId) parts.push(`accountUserId:${accountUserId}`);
    return parts.join("|");
  }
  if (accountId && accountUserId) {
    return `accountId:${accountId}|accountUserId:${accountUserId}`;
  }
  if (accountUserId) return `accountUserId:${accountUserId}`;
  if (accountId) {
    return `accountId:${accountId}`;
  }
  return `refreshToken:${refreshToken}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}

export function toAccountIdentityKeys(
  account: Pick<AccountMetadataV3, "organizationId" | "accountId" | "accountUserId" | "refreshToken">,
): string[] {
  const keys: string[] = [];
  const accountUserId =
    typeof account.accountUserId === "string" ? account.accountUserId.trim() : "";
  if (accountUserId) {
    const accountId = typeof account.accountId === "string" ? account.accountId.trim() : "";
    const organizationId =
      typeof account.organizationId === "string" ? account.organizationId.trim() : "";
    keys.push(`seat:${organizationId}|${accountId}|${accountUserId}`);
  }
  const organizationId = typeof account.organizationId === "string" ? account.organizationId.trim() : "";
  if (organizationId) {
    keys.push(`organizationId:${organizationId}`);
  }

  const accountId = typeof account.accountId === "string" ? account.accountId.trim() : "";
  if (accountId) {
    keys.push(`accountId:${accountId}`);
  }

  // Ranked BELOW organizationId/accountId on purpose. One OAuth grant can back
  // several workspace variants that all carry the same member id, so a bare
  // member key must never outrank a workspace key when resolving the target of
  // a single-use refresh-token write.
  if (accountUserId) {
    keys.push(`accountUserId:${accountUserId}`);
  }

  const refreshToken = typeof account.refreshToken === "string" ? account.refreshToken.trim() : "";
  if (refreshToken) {
    keys.push(`refreshToken:${refreshToken}`);
  }

  return keys;
}

export function toAccountIdentityKey(
  account: Pick<AccountMetadataV3, "organizationId" | "accountId" | "accountUserId" | "refreshToken">,
): string | undefined {
  return toAccountIdentityKeys(account)[0];
}

export function extractActiveKeys(accounts: unknown[], activeIndex: number): string[] {
  const candidate = accounts[activeIndex];
  if (!isRecord(candidate)) return [];

  return toAccountIdentityKeys({
    organizationId: typeof candidate.organizationId === "string" ? candidate.organizationId : undefined,
    accountId: typeof candidate.accountId === "string" ? candidate.accountId : undefined,
    accountUserId:
      typeof candidate.accountUserId === "string"
        ? candidate.accountUserId
        : extractAccountUserId(
            typeof candidate.accessToken === "string" ? candidate.accessToken : undefined,
          ),
    refreshToken: typeof candidate.refreshToken === "string" ? candidate.refreshToken : "",
  });
}

export function findAccountIndexByIdentityKeys(
  accounts: Pick<AccountMetadataV3, "organizationId" | "accountId" | "accountUserId" | "refreshToken">[],
  identityKeys: string[],
): number {
  if (identityKeys.length === 0) return -1;
  for (const identityKey of identityKeys) {
    const idx = accounts.findIndex((account) => toAccountIdentityKeys(account).includes(identityKey));
    if (idx >= 0) {
      return idx;
    }
  }
  return -1;
}

function selectNewestAccount<T extends AccountLike>(
  current: T | undefined,
  candidate: T,
): T {
  if (!current) return candidate;
  const currentLastUsed = current.lastUsed || 0;
  const candidateLastUsed = candidate.lastUsed || 0;
  if (candidateLastUsed > currentLastUsed) return candidate;
  if (candidateLastUsed < currentLastUsed) return current;
  const currentAddedAt = current.addedAt || 0;
  const candidateAddedAt = candidate.addedAt || 0;
  return candidateAddedAt >= currentAddedAt ? candidate : current;
}

function pickNewestAccountIndex<T extends AccountLike>(
  accounts: T[],
  existingIndex: number,
  candidateIndex: number,
): number {
  const existing = accounts[existingIndex];
  const candidate = accounts[candidateIndex];
  if (!existing) return candidateIndex;
  if (!candidate) return existingIndex;
  const newest = selectNewestAccount(existing, candidate);
  return newest === candidate ? candidateIndex : existingIndex;
}

function isOrgLikeAccount<T extends AccountLike>(account: T): boolean {
  return (
    !!normalizeWorkspaceIdentityPart(account.organizationId) ||
    account.accountIdSource === "org"
  );
}

/**
 * Resolve which records govern disable state and its provenance.
 *
 * Default is fail-closed: if either side is explicitly disabled, the merge is
 * disabled. The ONE exception (issue #171): when exactly one side is an
 * org-backed real account and the other is a token-source duplicate (a plugin
 * re-login artifact), the org account's own `enabled` state governs. A disabled
 * token duplicate must never silently disable the real account it collapses
 * into — otherwise the canonical account becomes unroutable and unrecoverable.
 */
function getDisableStateSources<T extends AccountLike>(target: T, source: T): T[] {
  const targetOrgLike = isOrgLikeAccount(target);
  const sourceOrgLike = isOrgLikeAccount(source);
  const targetTokenDup = !targetOrgLike && target.accountIdSource === "token";
  const sourceTokenDup = !sourceOrgLike && source.accountIdSource === "token";

  if (targetOrgLike && sourceTokenDup) return [target];
  if (sourceOrgLike && targetTokenDup) return [source];
  return [target, source];
}

function resolveMergedEnabled<T extends AccountLike>(target: T, source: T): boolean | undefined {
  const sources = getDisableStateSources(target, source);
  // Fail-closed for every other shape (same-identity, two real accounts, etc.).
  if (sources.some((account) => account.enabled === false)) return false;
  return sources[0]?.enabled ?? sources[1]?.enabled;
}

function resolveMergedUserDisabled<T extends AccountLike>(target: T, source: T): boolean | undefined {
  const sources = getDisableStateSources(target, source);
  if (sources.some(isUserDisabled)) return true;
  return sources.find((account) => account.userDisabled !== undefined)?.userDisabled;
}

function mergeAccountRecords<T extends AccountLike>(target: T, source: T): T {
  const newest = selectNewestAccount(target, source);
  const older = newest === target ? source : target;
  const merged = { ...older, ...newest };
  // Notes are editable operator text, but a retained disable must keep its
  // routing guard. Only records governing that disable may supply attribution.
  let accountNote = hasAutoDisableNote(merged.accountNote)
    ? stripAutoDisableNote(merged.accountNote)
    : merged.accountNote;
  const disableStateSources = getDisableStateSources(target, source);
  for (const marker of [AUTH_FAILURE_DISABLE_NOTE_MARKER, WORKSPACE_DEACTIVATED_NOTE_MARKER]) {
    if (disableStateSources.some(
      (account) => account.enabled === false && account.accountNote?.includes(marker),
    )) {
      accountNote = accountNote ? `${accountNote} ${marker}` : marker;
    }
  }
  return {
    ...merged,
    organizationId: target.organizationId ?? source.organizationId,
    accountId: target.accountId ?? source.accountId,
    accountUserId: target.accountUserId ?? source.accountUserId,
    accountIdSource: target.accountIdSource ?? source.accountIdSource,
    accountLabel: target.accountLabel ?? source.accountLabel,
    accountNote,
    email: target.email ?? source.email,
    enabled: resolveMergedEnabled(target, source),
    userDisabled: resolveMergedUserDisabled(target, source),
  };
}

function sameOptionalIdentity(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeWorkspaceIdentityPart(left);
  const normalizedRight = normalizeWorkspaceIdentityPart(right);
  return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
}

/**
 * Email-specific identity comparison. Emails are case-insensitive, so this
 * normalizes with `trim().toLowerCase()`. This MUST match the normalization in
 * `lib/accounts/stale-state.ts` (findDisabledTokenSourceDuplicates) so the
 * storage-merge layer and the codex-doctor/codex-health detectors agree on
 * whether two records are the same account (issue #171): a divergence let
 * `User@Example.com` (org) and `user@example.com` (disabled token re-login)
 * escape dedup yet still get flagged as a removable duplicate.
 */
function sameEmailIdentity(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = normalizeWorkspaceIdentityPart(left)?.toLowerCase();
  const normalizedRight = normalizeWorkspaceIdentityPart(right)?.toLowerCase();
  return !!normalizedLeft && !!normalizedRight && normalizedLeft === normalizedRight;
}

function isLegacyRefreshTokenDuplicate<T extends AccountLike>(left: T, right: T): boolean {
  const refreshToken = normalizeWorkspaceIdentityPart(left.refreshToken);
  const leftAccountUserId = normalizeWorkspaceIdentityPart(left.accountUserId);
  const rightAccountUserId = normalizeWorkspaceIdentityPart(right.accountUserId);
  if (leftAccountUserId && rightAccountUserId && leftAccountUserId !== rightAccountUserId) {
    return false;
  }
  const leftOrganizationId = normalizeWorkspaceIdentityPart(left.organizationId);
  const rightOrganizationId = normalizeWorkspaceIdentityPart(right.organizationId);
  if (leftOrganizationId && rightOrganizationId && leftOrganizationId !== rightOrganizationId) {
    return false;
  }
  const leftOrgLike = !!leftOrganizationId || left.accountIdSource === "org";
  const rightOrgLike = !!rightOrganizationId || right.accountIdSource === "org";
  const leftTokenLike = !leftOrganizationId && left.accountIdSource === "token";
  const rightTokenLike = !rightOrganizationId && right.accountIdSource === "token";
  if (
    ((leftOrgLike && rightTokenLike) || (rightOrgLike && leftTokenLike)) &&
    (sameEmailIdentity(left.email, right.email) ||
      (!!refreshToken && refreshToken === normalizeWorkspaceIdentityPart(right.refreshToken)))
  ) {
    return true;
  }
  if (!refreshToken || refreshToken !== normalizeWorkspaceIdentityPart(right.refreshToken)) {
    return false;
  }

  const leftAccountId = normalizeWorkspaceIdentityPart(left.accountId);
  const rightAccountId = normalizeWorkspaceIdentityPart(right.accountId);
  if (leftAccountId && rightAccountId && leftAccountId !== rightAccountId) {
    return false;
  }

  return (
    sameOptionalIdentity(left.accountId, right.accountId) ||
    (!leftOrganizationId && !!rightOrganizationId && !left.accountId) ||
    (!!leftOrganizationId && !rightOrganizationId && !right.accountId)
  );
}

function deduplicateLegacyRefreshTokenDuplicates<T extends AccountLike>(accounts: T[]): T[] {
  const working = [...accounts];
  const indicesToRemove = new Set<number>();

  for (let i = 0; i < working.length; i += 1) {
    if (indicesToRemove.has(i)) continue;
    const account = working[i];
    if (!account) continue;

    for (let j = i + 1; j < working.length; j += 1) {
      if (indicesToRemove.has(j)) continue;
      const candidate = working[j];
      if (!candidate || !isLegacyRefreshTokenDuplicate(account, candidate)) continue;

      const accountOrgLike = !!normalizeWorkspaceIdentityPart(account.organizationId) || account.accountIdSource === "org";
      const candidateOrgLike = !!normalizeWorkspaceIdentityPart(candidate.organizationId) || candidate.accountIdSource === "org";
      const newestIndex = accountOrgLike && !candidateOrgLike
        ? i
        : candidateOrgLike && !accountOrgLike
          ? j
          : pickNewestAccountIndex(working, i, j);
      const obsoleteIndex = newestIndex === i ? j : i;
      const target = working[newestIndex];
      const source = working[obsoleteIndex];
      if (target && source) {
        working[newestIndex] = mergeAccountRecords(target, source);
      }
      indicesToRemove.add(obsoleteIndex);
      if (obsoleteIndex === i) break;
    }
  }

  return working.filter((account, index) => !!account && !indicesToRemove.has(index));
}

/**
 * Backfill the member id onto records that predate it, but only when the
 * workspace has exactly ONE seat to attribute them to.
 *
 * `toAccountIdentityKey` returns a `seat:` key for member-bearing records, so a
 * legacy twin whose access token no longer decodes would keep the older
 * `organizationId:`/`accountId:` key and stop deduplicating against its own
 * newer record, surviving as a rotation slot with a dead refresh token. Merging
 * is only safe when attribution is unambiguous: with two or more seats in the
 * workspace there is no way to tell which one the memberless record belongs to,
 * so it is left alone.
 */
function backfillUniqueSeatIdentity<T extends AccountLike>(accounts: T[]): T[] {
  const seatsByWorkspace = new Map<string, Set<string>>();
  for (const account of accounts) {
    const accountUserId = account?.accountUserId?.trim();
    if (!account || !accountUserId) continue;
    const workspaceKey = JSON.stringify([
      account.organizationId?.trim() ?? "",
      account.accountId?.trim() ?? "",
    ]);
    const seats = seatsByWorkspace.get(workspaceKey);
    if (seats) seats.add(accountUserId);
    else seatsByWorkspace.set(workspaceKey, new Set([accountUserId]));
  }

  return accounts.map((account) => {
    if (!account || account.accountUserId?.trim()) return account;
    const organizationId = account.organizationId?.trim() ?? "";
    const accountId = account.accountId?.trim() ?? "";
    if (!organizationId && !accountId) return account;
    const seats = seatsByWorkspace.get(JSON.stringify([organizationId, accountId]));
    if (!seats || seats.size !== 1) return account;
    const [accountUserId] = [...seats];
    return accountUserId ? ({ ...account, accountUserId } as T) : account;
  });
}

function deduplicateAccountsByKey<T extends AccountLike>(accounts: T[]): T[] {
  const working = backfillUniqueSeatIdentity(accounts);
  const keyToIndex = new Map<string, number>();
  const indicesToRemove = new Set<number>();

  for (let i = 0; i < working.length; i += 1) {
    const account = working[i];
    if (!account) continue;
    const key = toAccountIdentityKey(account);
    if (!key) continue;

    const existingIndex = keyToIndex.get(key);
    if (existingIndex === undefined) {
      keyToIndex.set(key, i);
      continue;
    }

    const newestIndex = pickNewestAccountIndex(working, existingIndex, i);
    const obsoleteIndex = newestIndex === existingIndex ? i : existingIndex;
    const target = working[newestIndex];
    const source = working[obsoleteIndex];
    if (target && source) {
      working[newestIndex] = mergeAccountRecords(target, source);
    }
    indicesToRemove.add(obsoleteIndex);
    keyToIndex.set(key, newestIndex);
  }

  const result: T[] = [];
  for (let i = 0; i < working.length; i += 1) {
    if (indicesToRemove.has(i)) continue;
    const account = working[i];
    if (account) result.push(account);
  }
  return result;
}

/**
 * Removes duplicate accounts, keeping the most recently used entry for each unique key.
 * Deduplication identity hierarchy: workspace + member identity, then refreshToken.
 * @param accounts - Array of accounts to deduplicate
 * @returns New array with duplicates removed
 */
export function deduplicateAccounts<T extends { organizationId?: string; accountId?: string; accountUserId?: string; refreshToken: string; lastUsed?: number; addedAt?: number }>(
  accounts: T[],
): T[] {
  return deduplicateAccountsByKey(accounts);
}

/**
 * Removes duplicate legacy accounts by email, keeping the most recently used entry.
 * Accounts with organizationId/accountId are never merged by email to avoid collapsing workspace variants.
 * Accounts without email are always preserved.
 * @param accounts - Array of accounts to deduplicate
 * @returns New array with email duplicates removed
 */
export function deduplicateAccountsByEmail<T extends { organizationId?: string; accountId?: string; email?: string; lastUsed?: number; addedAt?: number }>(
  accounts: T[],
): T[] {
  const emailToNewestIndex = new Map<string, number>();
  const indicesToKeep = new Set<number>();

  for (let i = 0; i < accounts.length; i += 1) {
    const account = accounts[i];
    if (!account) continue;

    const organizationId = account.organizationId?.trim();
    if (organizationId) {
      indicesToKeep.add(i);
      continue;
    }

    const accountId = account.accountId?.trim();
    if (accountId) {
      indicesToKeep.add(i);
      continue;
    }

    const email = account.email?.trim().toLowerCase();
    if (!email) {
      indicesToKeep.add(i);
      continue;
    }

    const existingIndex = emailToNewestIndex.get(email);
    if (existingIndex === undefined) {
      emailToNewestIndex.set(email, i);
      continue;
    }

    const existing = accounts[existingIndex];
    // istanbul ignore next -- defensive code: existingIndex always refers to valid account
    if (!existing) {
      emailToNewestIndex.set(email, i);
      continue;
    }

    const existingLastUsed = existing.lastUsed || 0;
    const candidateLastUsed = account.lastUsed || 0;
    const existingAddedAt = existing.addedAt || 0;
    const candidateAddedAt = account.addedAt || 0;

    const isNewer =
      candidateLastUsed > existingLastUsed ||
      (candidateLastUsed === existingLastUsed && candidateAddedAt > existingAddedAt);

    if (isNewer) {
      emailToNewestIndex.set(email, i);
    }
  }

  for (const idx of emailToNewestIndex.values()) {
    indicesToKeep.add(idx);
  }

  const result: T[] = [];
  for (let i = 0; i < accounts.length; i += 1) {
    if (indicesToKeep.has(i)) {
      const account = accounts[i];
      if (account) result.push(account);
    }
  }
  return result;
}

/**
 * Applies storage deduplication semantics used by normalize/import paths.
 * 1) Dedupe only exact workspace/member identity duplicates, then refreshToken,
 *    preserving distinct workspace variants that share a refresh token.
 * 2) Then apply legacy email dedupe only for entries that still do not have organizationId/accountId.
 */
export function deduplicateAccountsForStorage<T extends AccountLike & { email?: string }>(accounts: T[]): T[] {
  return deduplicateAccountsByEmail(deduplicateLegacyRefreshTokenDuplicates(deduplicateAccountsByKey(accounts)));
}
