// Explicit product dates take precedence; old stored lines retain the cart default.
export function lineDeadline(cart, line) {
  const value = line.deadline ?? cart?.deadline ?? line.matchDeadline ?? null;
  return value == null ? null : new Date(value).toISOString();
}

// A delivery is one shop's lines sharing a delivery key. Null is the shop's
// main delivery; a client "deliver separately" choice gives the other lines keys.
export function lineDeliveryKey(line) {
  return line.deliveryKey ?? null;
}

export function sameDelivery(left, right) {
  return left.supplierId === right.supplierId && lineDeliveryKey(left) === lineDeliveryKey(right);
}

/** The earliest of the given dates, ignoring missing ones. */
export function earliestDate(dates) {
  return dates.filter(value => value != null).map(value => new Date(value).toISOString())
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
}

// A delivery works to the earliest date among its products.
export function groupDeadline(cart, lines) {
  return earliestDate(lines.map(line => lineDeadline(cart, line)));
}

/**
 * One group per shop delivery, in first-appearance order. `deliveryNumber` is
 * 1-based among that shop's deliveries; `shopDeliveryCount` > 1 means the
 * client chose separate deliveries from one shop.
 */
export function cartGroups(cart, lines) {
  const groups = new Map();
  for (const line of lines) {
    const deliveryKey = lineDeliveryKey(line);
    const key = JSON.stringify([line.supplierId, deliveryKey]);
    if (!groups.has(key)) groups.set(key, { supplierId: line.supplierId, deliveryKey, lines: [] });
    groups.get(key).lines.push(line);
  }
  const result = [...groups.values()];
  const counts = new Map();
  for (const group of result) {
    group.deadline = groupDeadline(cart, group.lines);
    counts.set(group.supplierId, (counts.get(group.supplierId) || 0) + 1);
    group.deliveryNumber = counts.get(group.supplierId);
  }
  for (const group of result) group.shopDeliveryCount = counts.get(group.supplierId);
  return result;
}

export function sharedDeadline(groups) {
  const dates = new Set(groups.map(group => group.deadline));
  return dates.size === 1 ? groups[0].deadline : null;
}

export function groupSummary(groups) {
  return { groupCount: groups.length, shopCount: new Set(groups.map(group => group.supplierId)).size,
    isMultiGroup: groups.length > 1 };
}
