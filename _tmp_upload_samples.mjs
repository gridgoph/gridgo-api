import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createObjectStorage } from "./src/object-storage.js";

const GENERATED = {
  "dev/lovis/lst_document_printing.jpg": "/tmp/gridgo-samples/out/lst_document_printing.jpg",
  "dev/lovis/lst_booklets.jpg": "/tmp/gridgo-samples/out/lst_booklets.jpg",
  "dev/lovis/lst_risograph.jpg": "/tmp/gridgo-samples/out/lst_risograph.jpg",
  "dev/lovis/lst_binding_hardbound.jpg": "/tmp/gridgo-samples/out/lst_binding_hardbound.jpg",
  "dev/lovis/lst_id_photos.jpg": "/tmp/gridgo-samples/out/lst_id_photos.jpg",
  "dev/polymedia/lst_business_store_signages.jpg": "/tmp/gridgo-samples/out/lst_business_store_signages.jpg",
};

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const storage = createObjectStorage(process.env);
await storage.ensureBucket();

const rows = JSON.parse(readFileSync("/tmp/gridgo-samples/files.json", "utf8"));

mkdirSync("/tmp/gridgo-samples/existing", { recursive: true });
const updates = [];

for (const row of rows) {
  let local = GENERATED[row.object_key];
  if (!local) {
    const raw = `/tmp/gridgo-samples/existing/${row.file_id}.jpg`;
    const marked = `/tmp/gridgo-samples/existing/${row.file_id}.wm.jpg`;
    const body = await streamToBuffer(await storage.getObject(row.object_key));
    writeFileSync(raw, body);
    if (body.length < 1000) {
      console.log("skip tiny (should have been generated)", row.object_key, body.length);
      continue;
    }
    const py = spawnSync("python3", ["/tmp/gridgo-samples/watermark_one.py", raw, marked], { encoding: "utf8" });
    if (py.status !== 0) {
      console.error(py.stderr || py.stdout);
      throw new Error(`watermark failed for ${row.object_key}`);
    }
    local = marked;
  }
  const jpeg = readFileSync(local);
  await storage.putObject({
    key: row.object_key,
    body: jpeg,
    contentType: "image/jpeg",
    size: jpeg.length,
  });
  updates.push({ file_id: row.file_id, key: row.object_key, bytes: jpeg.length });
  console.log("put", row.object_key, jpeg.length);
}

writeFileSync("/tmp/gridgo-samples/updates.json", JSON.stringify(updates, null, 2));
console.log(JSON.stringify({ count: updates.length }));
