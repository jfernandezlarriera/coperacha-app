// Contribution rules (pure functions). See README "Reglas de montos".
//
// 1. Equal share = ceil(goal / N), where N = number of joined participants (any mode).
//    It changes as people join.
// 2. Public amounts = fixed amounts + resolved equal shares. Majority-cap pledges are never
//    public.
// 3. Majority amount = most frequent public amount; ties go to the higher amount; with no
//    public amounts it falls back to the equal share.
// 4. A majority-cap participant pays min(majority amount, their private cap X).
// 5. Running total (before confirmation) counts every participant at their current resolved
//    amount, including majority-cap pledges at min(majority, X). Only the aggregate is shown.
// 6. Amounts are frozen (finalCents) when the organizer confirms the colecta. A below-goal
//    confirmation still resolves against the original goal, then stores that total as the new
//    goal; equal shares and majority-cap amounts are never recomputed upward or downward.

export function equalShareCents(goalCents, participantCount) {
  if (participantCount <= 0) return goalCents;
  return Math.ceil(goalCents / participantCount);
}

export function majorityAmount(publicAmounts, fallback) {
  if (publicAmounts.length === 0) return fallback;
  const counts = new Map();
  for (const a of publicAmounts) counts.set(a, (counts.get(a) || 0) + 1);
  let best = null;
  for (const [amount, count] of counts) {
    if (best === null || count > best.count || (count === best.count && amount > best.amount)) {
      best = { amount, count };
    }
  }
  return best.amount;
}

// Returns { share, majority, byParticipant: Map(id -> {publicCents|null, resolvedCents}), totalCents }.
export function resolveAmounts(goalCents, participants) {
  const share = equalShareCents(goalCents, participants.length);
  const publicAmounts = [];
  const byParticipant = new Map();
  for (const p of participants) {
    if (p.mode === 'fixed') {
      publicAmounts.push(p.fixedCents);
      byParticipant.set(p.id, { publicCents: p.fixedCents, resolvedCents: p.fixedCents });
    } else if (p.mode === 'equal') {
      publicAmounts.push(share);
      byParticipant.set(p.id, { publicCents: share, resolvedCents: share });
    }
  }
  const majority = majorityAmount(publicAmounts, share);
  for (const p of participants) {
    if (p.mode === 'majority_cap') {
      byParticipant.set(p.id, { publicCents: null, resolvedCents: Math.min(majority, p.capCents) });
    }
  }
  let totalCents = 0;
  for (const v of byParticipant.values()) totalCents += v.resolvedCents;
  return { share, majority, byParticipant, totalCents };
}

export function progress(goalCents, totalCents) {
  const remainingCents = Math.max(0, goalCents - totalCents);
  const percent = goalCents > 0 ? Math.min(100, Math.floor((totalCents * 100) / goalCents)) : 0;
  return { remainingCents, percent, reached: totalCents >= goalCents };
}
