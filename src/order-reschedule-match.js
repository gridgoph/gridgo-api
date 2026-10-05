import { isDeepStrictEqual } from 'node:util';
import { matchShop, MatchError, projectShopFinish } from './order-match.js';
import { catalogGroupsForItem, createOrderLineSnapshot, listingFitsPrinterCap } from './supplier-catalog.js';

const normalize = (text) => String(text || '').trim().toLowerCase();

/** Conservative equivalence: do not turn a same-category match into a different product. */
function equivalentSelection(store, order, line, item) {
  const source = store.catalogItems.find((row) => row.id === line.sourceCatalogItemId);
  if (!source || item.subcategoryCode !== source.subcategoryCode
      || normalize(item.name) !== normalize(line.itemNameSnapshot)
      || normalize(item.description) !== normalize(line.descriptionSnapshot)
      || (item.pricingUnit || 'per_unit') !== line.pricingUnitSnapshot
      || (item.packageQty ?? null) !== (line.packageQtySnapshot ?? null)
      || (item.measureUnit ?? null) !== (line.structuredSpecSnapshot?.measureUnit ?? null)) return null;
  const groups = catalogGroupsForItem(store, item.id, { includeInactiveOptions: false });
  const options = (store.orderLineItemOptions || []).filter((row) => row.orderLineItemId === line.id);
  const optionIds = [];
  for (const selected of options) {
    const group = groups.find((row) => normalize(row.name) === normalize(selected.groupNameSnapshot)
      && (row.kind || 'spec') === (selected.groupKindSnapshot || 'spec'));
    const option = group?.options.find((row) => normalize(row.label) === normalize(selected.optionLabelSnapshot));
    if (!option) return null;
    optionIds.push(option.id);
  }
  const bindings = groups.flatMap((group) => group.options).filter((option) => optionIds.includes(option.id)).map((option) => option.specBinding).filter(Boolean);
  for (const [field, value] of Object.entries(line.structuredSpecSnapshot || {})) {
    if (field === 'measureUnit') continue;
    if (!bindings.some((binding) => binding.fieldCode === field
        && (isDeepStrictEqual(binding.value, value) || isDeepStrictEqual(binding.valueCode, value)))) return null;
  }
  const service = store.supplierServices.find((row) => row.id === item.supplierServiceId);
  try {
    if (!listingFitsPrinterCap(item, { optionIds, measurement: line.measurement, structuredSpec: line.structuredSpecSnapshot }, store)) return null;
    const candidateStore = { ...store, orders: [{ ...order, supplierId: item.supplierId }] };
    const snapshot = createOrderLineSnapshot(candidateStore, { orderId: order.id, catalogItemId: item.id,
      expectedVersion: item.version, expectedServiceVersion: service?.version || 1,
      quantity: line.quantity, measurement: line.measurement, structuredSpec: line.structuredSpecSnapshot,
      optionIds, createdAt: order.createdAt, lineItemId: line.id });
    if ([...(line.acceptedFormatCodesSnapshot || []), ...(line.artworkLinks || []).map((link) => link.formatCode)].some((code) => !snapshot.lineItem.acceptedFormatCodesSnapshot.includes(code))) return null;
    return { lineId: line.id, catalogItemId: item.id, version: item.version, serviceVersion: service?.version || 1,
      optionIds, subtotalMinor: snapshot.lineItem.lineSubtotalMinor, turnaroundHours: snapshot.lineItem.turnaroundHoursSnapshot };
  } catch (error) {
    if (error.status) return null;
    throw error;
  }
}

/** Re-evaluated at consent time. Original immutable order lines remain the production instructions. */
export function findRescheduleReplacement(store, order, at, onlySupplierId = null) {
  const lines = (store.orderLineItems || []).filter((row) => row.orderId === order.id);
  if (!lines.length || (store.orderJobs || []).some((job) => job.orderId === order.id && job.supplierId !== order.supplierId)) return null;
  const selections = new Map();
  const excluded = new Set([order.supplierId, ...(order.declinedBy || [])]);
  for (const item of store.catalogItems || []) {
    if (excluded.has(item.supplierId) || (onlySupplierId && item.supplierId !== onlySupplierId)) continue;
    if (!selections.has(item.supplierId)) selections.set(item.supplierId, []);
  }
  for (const [supplierId] of selections) {
    const chosen = lines.map((line) => (store.catalogItems || []).filter((item) => item.supplierId === supplierId)
      .map((item) => equivalentSelection(store, order, line, item)).filter(Boolean)
      .sort((a, b) => a.subtotalMinor - b.subtotalMinor || a.catalogItemId.localeCompare(b.catalogItemId))[0]);
    if (chosen.some((row) => !row)
        || chosen.reduce((sum, row) => sum + BigInt(row.subtotalMinor), 0n) > BigInt(order.supplierSubtotalMinor)) selections.delete(supplierId);
    else selections.set(supplierId, chosen);
  }
  if (!selections.size) return null;
  const source = store.catalogItems.find((item) => item.id === lines[0].sourceCatalogItemId);
  const preference = (store.clientPreferences || []).find((row) => row.userId === order.clientId || row.clientId === order.clientId);
  const allowedItems = new Set([...selections.values()].flat().map((row) => row.catalogItemId));
  const matchStore = { ...store, catalogItems: store.catalogItems.filter((item) => allowedItems.has(item.id)) };
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);
  while (selections.size) {
    let match;
    try {
      match = matchShop(matchStore, { subcategoryCode: source.subcategoryCode,
        ranking: preference?.ranking || ['quality', 'speed', 'cost', 'distance'], dropoff: order.dropoff || null,
        deadline: order.promiseBy || order.promisedDate || order.deadline, now: at, units,
        excludedSupplierIds: [...excluded] });
    } catch (error) {
      if (error instanceof MatchError) return null;
      throw error;
    }
    const supplierId = match.shop.supplierId;
    const chosen = selections.get(supplierId);
    const { projection } = projectShopFinish(store, { supplierId, now: at, units,
      turnaroundHours: Math.max(...chosen.map((row) => row.turnaroundHours)) });
    const deadline = order.promiseBy || order.promisedDate || order.deadline;
    if (Date.parse(projection.promiseBy) <= Date.parse(deadline)) {
      const profile = store.supplierProfiles.find((row) => row.userId === supplierId);
      return { supplierId, pickup: structuredClone(profile.shop), readyBy: projection.readyBy,
        promiseBy: deadline, selections: chosen };
    }
    excluded.add(supplierId); selections.delete(supplierId);
  }
  return null;
}

export function sameReplacementSelection(left, right) {
  return left?.supplierId === right?.supplierId && isDeepStrictEqual(left?.selections, right?.selections)
    && isDeepStrictEqual(left?.pickup, right?.pickup);
}
