// Gift proposals and votes. Rule: one vote per person (participant or organizer); voting
// again replaces the previous vote. Winner = most votes; ties go to the earliest proposal.

export function tally(proposals, votes) {
  const counts = new Map(proposals.map((p) => [p.id, 0]));
  for (const v of votes) if (counts.has(v.proposalId)) counts.set(v.proposalId, counts.get(v.proposalId) + 1);
  return counts;
}

export function winner(proposals, votes) {
  if (proposals.length === 0) return null;
  const counts = tally(proposals, votes);
  const sorted = proposals.slice().sort((a, b) => {
    const diff = counts.get(b.id) - counts.get(a.id);
    if (diff !== 0) return diff;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
  return sorted[0];
}

export function voteOf(votes, voter) {
  return votes.find((v) => v.voter === voter) || null;
}
