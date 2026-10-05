import { supplierArtworkReleased } from "./artwork-gates.js";
// Shared by order projections and file metadata/download authorization.
export function canReadOrderArtwork(user, store, order, fileId, purpose, file = null) {
  if (!user || !order || !["artwork", "mockup"].includes(purpose)) return false;
  if (["ops_admin", "super_admin"].includes(user.role)
      || (user.role === "client" && order.clientId === user.id)) return true;
  if (!["supplier", "rider"].includes(user.role)) return false;

  if (user.role === "supplier" && !supplierArtworkReleased(order)) return false;
  const partyField = user.role === "supplier" ? "supplierId" : "riderId";
  const jobs = (store?.orderJobs || []).filter((job) => job.orderId === order.id);
  const ownJobs = new Set(jobs.filter((job) => job[partyField] === user.id).map((job) => job.id));
  const ownsLine = (line) => jobs.length ? ownJobs.has(line.jobId) : order[partyField] === user.id;
  const lines = (store?.orderLineItems || []).filter((line) => line.orderId === order.id);
  const field = `${purpose}FileId`;
  const record = file || (store?.files || []).find((candidate) => candidate.fileId === fileId);
  const lineRefs = (record?.references || []).filter((ref) =>
    ref.type === "order" && ref.id === order.id && ref.field?.startsWith("line:"));
  if (lineRefs.length) {
    // A broad legacy reference must not bypass a specific (even stale) line reference.
    return lineRefs.some((ref) => lines.some((line) =>
      ref.field === `line:${line.id}:${purpose}` && line[field] === fileId && ownsLine(line)));
  }
  const fileLines = lines.filter((line) => line[field] === fileId);
  if (fileLines.length) return fileLines.some(ownsLine);

  // Unattributed legacy files are safe only when the order has one shop.
  const suppliers = new Set([order.supplierId, ...jobs.map((job) => job.supplierId)].filter(Boolean));
  return suppliers.size <= 1 && (order[partyField] === user.id || ownJobs.size > 0);
}
