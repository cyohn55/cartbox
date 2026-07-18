/**
 * Claim authority for catalog titles — who may edit a listing, who may set a
 * price, and how primary status changes hands.
 *
 * Pure decision logic, deliberately free of database access, so the rules can be
 * exercised directly by tests and reused by both server routes and UI gating.
 * The database enforces the money-moving subset independently (see the pricing
 * trigger in 0011_titles_catalog.sql); this module must agree with it, never
 * relax it.
 *
 * The model in one line: a title may carry several stewards, exactly one of whom
 * is the primary account representative; pricing authority belongs to the
 * primary alone and never delegates.
 */

import { licensePermitsCommercial } from "./licensing";
import type { ContentTier } from "./titleRuntime";

export type ClaimLevel = "steward" | "rightsholder";
export type ClaimStatus = "pending" | "active" | "suspended" | "revoked";

export interface TitleClaim {
  titleId: string;
  profileId: string;
  level: ClaimLevel;
  isPrimary: boolean;
  status: ClaimStatus;
  /** The primary who delegated this claim; null for a primary claim. */
  grantedBy: string | null;
  lastActiveAt: Date;
}

/** The subset of a title the claim rules need to reason about. */
export interface ClaimableTitle {
  id: string;
  tier: ContentTier;
  license: string;
}

/**
 * A permission outcome. Denials carry a reason so the UI can explain *why* an
 * action is unavailable — "this license forbids charging" is actionable in a way
 * that a greyed-out button is not.
 */
export type Permission = { allowed: true } | { allowed: false; reason: string };

const ALLOW: Permission = { allowed: true };

function deny(reason: string): Permission {
  return { allowed: false, reason };
}

/** A claim carries authority only while active. */
export function isLive(claim: TitleClaim): boolean {
  return claim.status === "active";
}

/**
 * Editing the listing — metadata, artwork, links, supported-release manifests.
 * Available to any active claim, which is the point of the steward level: an
 * active maintainer can curate their game's page without clearing the proof
 * standard designed for payouts.
 */
export function canEditListing(claim: TitleClaim): Permission {
  if (!isLive(claim)) {
    return deny(`claim is ${claim.status}, not active`);
  }
  return ALLOW;
}

/**
 * Granting and revoking subordinate stewards. The primary is the account
 * representative, so this is theirs alone — a subordinate cannot recruit peers
 * or unseat the primary who delegated to them.
 */
export function canManageStewards(claim: TitleClaim): Permission {
  if (!isLive(claim)) {
    return deny(`claim is ${claim.status}, not active`);
  }
  if (!claim.isPrimary) {
    return deny("only the primary claimant may manage stewards");
  }
  return ALLOW;
}

/**
 * Setting a price. The strictest gate in the model, because it is the one that
 * moves money, and it fails for reasons that are not all about the claimant:
 * the title's license and tier can forbid a price no matter who is asking.
 */
export function canSetPrice(claim: TitleClaim, title: ClaimableTitle): Permission {
  if (!isLive(claim)) {
    return deny(`claim is ${claim.status}, not active`);
  }
  if (!claim.isPrimary) {
    return deny("pricing authority belongs to the primary claimant and does not delegate");
  }
  if (claim.level !== "rightsholder") {
    return deny("setting a price requires a verified rightsholder claim");
  }
  if (title.tier === "B") {
    return deny("publisher freeware grants cover redistribution, not resale");
  }
  if (!licensePermitsCommercial(title.license)) {
    return deny(`the ${title.license} license does not permit commercial distribution`);
  }
  return ALLOW;
}

/**
 * Whether an actor may revoke a specific claim.
 *
 * Revocation is immediate and unilateral by design: subordinates are vouched for
 * by the primary rather than independently verified, so the primary must be able
 * to withdraw that vouching without ceremony.
 */
export function canRevokeClaim(actor: TitleClaim, target: TitleClaim): Permission {
  if (actor.titleId !== target.titleId) {
    return deny("claims belong to different titles");
  }
  const manage = canManageStewards(actor);
  if (!manage.allowed) {
    return manage;
  }
  if (target.isPrimary) {
    return deny("a primary claim is ended by review, not by revocation");
  }
  return ALLOW;
}

/**
 * Level changes are writable only by review — never by the claim's own holder.
 * Without this, a delegated steward is one self-service update away from
 * pricing rights.
 */
export function canSelfEscalate(): Permission {
  return deny("claim levels are set by review, not by the claimant");
}

// ---------------------------------------------------------------------------
// Succession
// ---------------------------------------------------------------------------

export interface SuccessionPolicy {
  /** How long a primary must be inactive before a transfer claim is reviewable. */
  inactivityMs: number;
  /** How long the incumbent has to respond once a transfer claim is filed. */
  noticeMs: number;
}

/**
 * Whether a subordinate may file a transfer claim against the incumbent primary.
 *
 * Inactivity opens a review; it does not decide one. A finished, stable game
 * with a quiet maintainer is not abandoned, so this returns only the right to
 * *ask* — the verdict is a human judgement over upstream activity and the
 * incumbent's response.
 */
export function canFileTransferClaim(
  petitioner: TitleClaim,
  incumbent: TitleClaim,
  now: Date,
  policy: SuccessionPolicy,
): Permission {
  if (petitioner.titleId !== incumbent.titleId) {
    return deny("claims belong to different titles");
  }
  if (!incumbent.isPrimary) {
    return deny("transfer claims are filed against the primary claimant");
  }
  if (petitioner.isPrimary) {
    return deny("the primary claimant already holds the title");
  }
  if (!isLive(petitioner)) {
    return deny(`claim is ${petitioner.status}, not active`);
  }
  const idleMs = now.getTime() - incumbent.lastActiveAt.getTime();
  if (idleMs < policy.inactivityMs) {
    return deny("the primary claimant is still active");
  }
  return ALLOW;
}

/**
 * Whether a filed transfer claim's notice window has closed. The incumbent
 * retains primary status simply by responding, so an unanswered notice is both
 * the fairness safeguard and the cleanest evidence that abandonment is real.
 */
export function isNoticeWindowClosed(
  filedAt: Date,
  incumbent: TitleClaim,
  now: Date,
  policy: SuccessionPolicy,
): boolean {
  if (incumbent.lastActiveAt.getTime() > filedAt.getTime()) {
    return false; // The incumbent responded; the claim lapses.
  }
  return now.getTime() - filedAt.getTime() >= policy.noticeMs;
}

/**
 * The claim state a successor takes on when review grants them primary status.
 *
 * A successor always arrives at steward level, whatever the outgoing primary
 * held. Reaching rightsholder requires passing that proof standard in their own
 * name. This is the load-bearing rule of the whole succession path: without it,
 * outlasting an inactive maintainer becomes a route to charging money for
 * someone else's game.
 */
export function promoteToPrimary(successor: TitleClaim): TitleClaim {
  return {
    ...successor,
    level: "steward",
    isPrimary: true,
    grantedBy: null, // A primary is granted by review, not by a person.
    status: "active",
  };
}

/**
 * The outgoing primary's claim after forfeiture. Revoked rather than deleted, so
 * the grant chain stays intact for audit and the listing's edit history remains
 * attributable.
 */
export function forfeitPrimary(incumbent: TitleClaim): TitleClaim {
  return { ...incumbent, isPrimary: false, status: "revoked" };
}
