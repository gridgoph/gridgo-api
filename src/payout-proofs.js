/*
 A payout stage lists each picture once.

 One picture can reach a stage as more than one upload. The rider app sends a
 single delivery capture twice -- as the delivery photo and as the delivered
 Proof of Fulfilment -- because a file is bound to one purpose, and recording
 the delivery then names the delivery photo as that same stage's proof. A shop
 retrying a filing whose answer was lost does the same. Each upload is its own
 file id, so comparing ids alone lists the picture twice.

 Two uploads are the same picture when their bytes hash the same. Files stored
 before uploads were hashed fall back to what the uploader sent: same owner,
 same file name, same size and same type. Different pictures never share all
 four in practice, and a hashed pair is never compared by name.
*/

/** How many distinct pictures one stage takes; a shop may file this many. */
export const MAX_PROOFS_PER_MILESTONE = 50;

export function sameProofFile(a, b) {
  if (!a || !b) return false;
  if (a.fileId === b.fileId) return true;
  if (a.contentSha256 && b.contentSha256) return a.contentSha256 === b.contentSha256;
  return Boolean(a.ownerId && a.originalFilename && Number.isFinite(a.size))
    && a.ownerId === b.ownerId
    && a.originalFilename === b.originalFilename
    && a.size === b.size
    && a.detectedContentType === b.detectedContentType;
}

const fileIn = (files, fileId) => (files || []).find((file) => file.fileId === fileId) || null;

/**
 * The stage's file ids, one per picture, in the order each picture was first
 * filed. The first copy still stored represents it, so a deleted copy never
 * hides one a screen can show. An id without a file record is kept: it can
 * only be compared by id.
 */
export function distinctProofIds(fileIds, files) {
  if (!Array.isArray(fileIds)) return [];
  if (fileIds.length < 2) return [...fileIds];
  const pictures = [];
  for (const fileId of new Set(fileIds)) {
    const file = fileIn(files, fileId);
    const picture = file && pictures.find((copies) => copies.some((copy) => sameProofFile(copy.file, file)));
    if (picture) picture.push({ fileId, file });
    else pictures.push([{ fileId, file }]);
  }
  return pictures.map((copies) => (copies.find((copy) => copy.file?.state === "ready") || copies[0]).fileId);
}

/** True when the stage already lists this picture under a copy still stored. */
export function stageListsProof(milestone, file, files) {
  return (milestone?.pofFileIds || []).some((fileId) => {
    if (fileId === file?.fileId) return true;
    const listed = fileIn(files, fileId);
    return listed?.state === "ready" && sameProofFile(listed, file);
  });
}

/**
 * List `fileId` as proof on the stage unless that picture is already there.
 * Returns whether it was added. Without its file record only the id is checked.
 */
export function addStageProof(milestone, fileId, files) {
  if (!Array.isArray(milestone.pofFileIds)) milestone.pofFileIds = [];
  const file = fileIn(files, fileId) || { fileId };
  if (stageListsProof(milestone, file, files)) return false;
  milestone.pofFileIds.push(fileId);
  return true;
}
