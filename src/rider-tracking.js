/** Location policy and progress contain no shop coordinates or handset diagnostics. */
export const ACTIVE_TRACKING_STATES = ['rider_assigned', 'picked_up', 'out_for_delivery'];
export const DELIVERY_TRACKING_STATES = ['picked_up', 'out_for_delivery'];
export const DEFAULT_LOCATION_REFRESH_SECONDS = 20;
export const DEFAULT_LOCATION_STALE_SECONDS = 120;

export function trackingSettings(settings) {
  return {
    refreshIntervalSeconds: settings?.riderLocationRefreshIntervalSeconds ?? DEFAULT_LOCATION_REFRESH_SECONDS,
    staleAfterSeconds: settings?.riderLocationStaleAfterSeconds ?? DEFAULT_LOCATION_STALE_SECONDS,
  };
}

export function pickupTime(order) {
  const assignedAt = assignmentTime(order);
  const at = order.pickupChecklist?.completedAt
    || (order.timeline || []).findLast(entry => entry.state === 'picked_up')?.at || null;
  return at && (!assignedAt || at >= assignedAt) ? at : null;
}

export function assignmentTime(order) {
  const timeline = order.timeline || [];
  return order.riderAssignedAt || timeline.findLast((entry, index) => entry.state === 'rider_assigned'
    && timeline[index - 1]?.state !== 'rider_assigned')?.at || null;
}

export function currentRiderPings(store, order) {
  const assignedAt = assignmentTime(order);
  return (store?.locationPings || []).filter(ping => ping.orderId === order.id && ping.riderId === order.riderId
    && (!assignedAt || ping.at >= assignedAt));
}

export function latestPing(pings) {
  return pings.reduce((latest, ping) => !latest || ping.at > latest.at ? ping : latest, null);
}

export function clientDeliveryActive(order) {
  return order.fulfillmentMode === 'delivery' && Boolean(order.riderId)
    && DELIVERY_TRACKING_STATES.includes(order.state) && !order.deliveryEvidence?.recordedAt;
}

export function clientRiderLocationPing(order, ping) {
  if (!clientDeliveryActive(order) || !ping || ping.riderId !== order.riderId || ping.leg === 'pickup') return null;
  if (!Number.isFinite(ping.lat) || Math.abs(ping.lat) > 90 || !Number.isFinite(ping.lng) || Math.abs(ping.lng) > 180) return null;
  const pickedUpAt = pickupTime(order);
  const assignedAt = assignmentTime(order);
  // Unmarked legacy fixes need a recorded handoff to establish their privacy window.
  if (!Number.isFinite(Date.parse(ping.at)) || (!pickedUpAt && ping.leg !== 'delivery')
      || (pickedUpAt && Date.parse(ping.at) < Date.parse(pickedUpAt))
      || (assignedAt && Date.parse(ping.at) < Date.parse(assignedAt))) return null;
  return ping;
}

export function locationFreshness(ping, settings, at = Date.now(), startedAt = null) {
  const { staleAfterSeconds } = trackingSettings(settings);
  const ageSeconds = ping ? Math.max(0, Math.floor((at - Date.parse(ping.at)) / 1000)) : null;
  const elapsed = startedAt ? at - Date.parse(startedAt) : Infinity;
  const stale = ping ? !Number.isFinite(ageSeconds) || at - Date.parse(ping.at) >= staleAfterSeconds * 1000
    : elapsed >= staleAfterSeconds * 1000;
  return { lastUpdatedAt: ping?.at ?? null, ageSeconds, stale };
}

export function clientTracking(order, ping, settings, settingsVersion, at = Date.now()) {
  const active = clientDeliveryActive(order);
  const visible = clientRiderLocationPing(order, ping);
  const freshness = active ? locationFreshness(visible, settings, at, pickupTime(order))
    : { lastUpdatedAt: null, ageSeconds: null, stale: false };
  return {
    status: !active ? 'inactive' : freshness.stale ? 'stale' : visible ? 'live' : 'waiting',
    ...trackingSettings(settings), settingsVersion, ...freshness,
    message: freshness.stale ? 'Rider location temporarily unavailable' : null,
  };
}

const MILESTONES = [
  ['rider_assigned', 'Rider assigned'],
  ['heading_to_shop', 'Heading to the shop'],
  ['at_shop', 'At the shop'],
  ['picked_up', 'Picked up'],
  ['on_the_way', 'On the way to you'],
  ['arrived', 'Arrived'],
];

export function deliveryMilestones(order) {
  const timeline = order.timeline || [];
  const assignedAt = assignmentTime(order);
  const progress = order.riderProgress?.riderId === order.riderId
    && order.riderProgress?.assignedAt === assignedAt ? order.riderProgress.events || {} : {};
  const eventAt = state => timeline.findLast(entry => entry.state === state && (!assignedAt || entry.at >= assignedAt))?.at || null;
  const times = {
    rider_assigned: assignedAt,
    heading_to_shop: progress.heading_to_shop || null,
    at_shop: progress.at_shop || null,
    picked_up: pickupTime(order),
    on_the_way: eventAt('out_for_delivery'),
    arrived: progress.arrived || (order.deliveryEvidence?.recordedAt && (!assignedAt || order.deliveryEvidence.recordedAt >= assignedAt)
      ? order.deliveryEvidence.recordedAt : null) || eventAt('delivered') || eventAt('issue_window_open'),
  };
  const reached = MILESTONES.reduce((last, [code], index) => times[code] ? index : last, order.riderId ? 0 : -1);
  return MILESTONES.map(([code, label], index) => ({ code, label, at: times[code],
    status: times[code] || (index === 0 && order.riderId) ? 'completed' : index < reached ? 'passed' : 'pending' }));
}

/** Bounded, coordinate-free samples. Legacy rows have no invented receive time. */
export function pingDiagnostics(pings, at = Date.now()) {
  const samples = pings.filter(ping => ping.receivedAt).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt)).slice(-100);
  let maxReceiveGapSeconds = null;
  const items = samples.map((ping, index) => {
    const receiveGapSeconds = index ? (Date.parse(ping.receivedAt) - Date.parse(samples[index - 1].receivedAt)) / 1000 : null;
    if (receiveGapSeconds != null) maxReceiveGapSeconds = Math.max(maxReceiveGapSeconds ?? 0, receiveGapSeconds);
    return { at: ping.at, receivedAt: ping.receivedAt, processedAt: ping.processedAt ?? null, receiveGapSeconds,
      sourceDelaySeconds: (Date.parse(ping.receivedAt) - Date.parse(ping.at)) / 1000 };
  });
  const last = samples.at(-1);
  return { sampleLimit: 100, sampleCount: items.length, maxReceiveGapSeconds,
    secondsSinceLastReceived: last ? Math.max(0, (at - Date.parse(last.receivedAt)) / 1000) : null, samples: items };
}
