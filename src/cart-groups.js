// Explicit product dates take precedence; old stored lines retain the cart default.
export function lineDeadline(cart, line) {
  const value = line.deadline ?? cart?.deadline ?? line.matchDeadline ?? null;
  return value == null ? null : new Date(value).toISOString();
}

export function cartGroups(cart, lines) {
  const groups = new Map();
  for (const line of lines) {
    const deadline = lineDeadline(cart, line);
    const key = JSON.stringify([line.supplierId, deadline]);
    if (!groups.has(key)) groups.set(key, { supplierId: line.supplierId, deadline, lines: [] });
    groups.get(key).lines.push(line);
  }
  return [...groups.values()];
}

export function sharedDeadline(groups) {
  const dates = new Set(groups.map(group => group.deadline));
  return dates.size === 1 ? groups[0].deadline : null;
}

export function groupSummary(groups) {
  return { groupCount: groups.length, shopCount: new Set(groups.map(group => group.supplierId)).size,
    isMultiGroup: groups.length > 1 };
}
