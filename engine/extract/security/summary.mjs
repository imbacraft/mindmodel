/**
 * A prefix's method checks in one clause: the commonest check with its own count, then how many checks there are. The
 * old line printed the first check and the count of *every* checked endpoint, which reads as if one check covered them.
 */
export const checkSummary = (p) => {
  const list = p?.checkCounts ?? [];
  const top = list[0];
  if (!top) return null;
  const distinct = list.length;
  // Against the prefix's endpoints, not against the checked ones: "2 of 2 checked" says nothing about how much of the
  // prefix the check covers, and the reader's question is how many of the 119 carry it.
  const more = distinct > 1 ? `, ${distinct} distinct checks` : '';
  return `${top.check} on ${top.count} of ${p.endpoints ?? p.checked} endpoint(s)${more}`;
};
