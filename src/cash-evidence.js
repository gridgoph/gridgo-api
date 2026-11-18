const ORDER_CASH_PURPOSES = new Set([
  'cash_shop_receipt', 'cash_no_show_photo', 'cash_return_photo', 'cash_remedy_receipt',
  'cash_reprint_receipt', 'cash_remedy_qr', 'cash_repayment_proof', 'cash_incident_photo', 'cash_shop_return',
]);
const CANDIDATE_PURPOSES = new Set(['cash_shop_return', 'cash_incident_photo']);

/** Staff-only picker: consumed order evidence plus the related rider's unused candidates. */
export async function listCashEvidence({store,order,storage}) {
  const progress=order.cashProgress || {}, assignments=new Map();
  for (const [riderId,assignedAt] of [
    [order.riderId,order.riderAssignedAt], [progress.noShowRiderId,order.riderAssignedAt],
    [progress.incident?.riderId,order.riderAssignedAt], [progress.redelivery?.riderId,progress.redelivery?.assignedAt],
  ]) {
    const time=Date.parse(assignedAt);
    if (riderId && Number.isFinite(time)) assignments.set(riderId,Math.min(assignments.get(riderId) ?? time,time));
  }
  const files=store.files.filter(file=>{
    if (file.state!=='ready' || !ORDER_CASH_PURPOSES.has(file.purpose)) return false;
    const refs=file.references || [];
    // Never borrow evidence already associated with another order or cash action.
    if (refs.some(ref=>ref.orderId && ref.orderId!==order.id || ref.type==='order' && ref.id!==order.id)) return false;
    if (refs.some(ref=>ref.type==='cash' && ref.orderId===order.id || ref.type==='order' && ref.id===order.id)) return true;
    return !refs.length && CANDIDATE_PURPOSES.has(file.purpose) && assignments.has(file.ownerId)
      && Date.parse(file.createdAt)>=assignments.get(file.ownerId);
  }).sort((a,b)=>b.createdAt.localeCompare(a.createdAt) || a.fileId.localeCompare(b.fileId));
  return {files:await Promise.all(files.map(async file=>{
    const result={fileId:file.fileId,purpose:file.purpose,
      ownerRole:store.users.find(user=>user.id===file.ownerId)?.role ?? null,
      uploadedAt:file.createdAt,used:!!file.references?.length,previewUrl:null,expiresAt:null};
    try {
      const stat=await storage.statObject(file.objectKey);
      if (stat.size!==file.size) throw Object.assign(new Error('File size mismatch'),{code:'storage_object_mismatch'});
      const signed=await storage.presignGet(file.objectKey,{privateFinancial:true});
      result.previewUrl=signed.url;result.expiresAt=signed.expiresAt;
    } catch (error) {
      result.unavailable=true;
      result.error=['storage_object_missing','storage_object_mismatch'].includes(error.code)?error.code:'minio_unavailable';
    }
    return result;
  }))};
}
