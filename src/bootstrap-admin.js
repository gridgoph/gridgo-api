import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import { authConfiguration, clerkClientProfile, createClerkBackend } from "./auth.js";
import { createDatabase } from "./database.js";
import { loadStore, saveStore } from "./postgres-store.js";

function generatedId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export async function bootstrapAdministrator({
  database,
  clerkBackend,
  clerkUserId,
  createId = generatedId,
  now = () => new Date().toISOString(),
}) {
  if (!String(clerkUserId || "").trim()) throw new Error("A Clerk user id is required for administrator bootstrap.");

  let clerkUser;
  try {
    clerkUser = await clerkBackend.users.getUser(clerkUserId);
  } catch {
    throw new Error("Clerk could not load the requested bootstrap identity. Verify the Clerk user id and instance configuration.");
  }
  const profile = clerkClientProfile(clerkUser);
  if (!profile.email || !profile.email.includes("@")) {
    throw new Error("The Clerk bootstrap identity must have an email address.");
  }

  return database.transaction(async () => {
    const completed = await database.query(
      "SELECT completed_at FROM administrator_bootstrap WHERE singleton = true",
    );
    if (completed.rowCount > 0) {
      throw new Error("Administrator bootstrap was already completed and is permanently closed.");
    }
    const store = await loadStore(database);
    if (store.users.some((user) => user.role === "ops_admin" || user.role === "super_admin")) {
      throw new Error("A privileged GRIDGO administrator already exists; administrator bootstrap is permanently closed.");
    }
    const linked = store.users.find((user) => user.clerkUserId === clerkUserId);
    const emailOwner = store.users.find((user) => String(user.email).toLowerCase() === profile.email);
    if (emailOwner && emailOwner !== linked) {
      throw new Error("The Clerk bootstrap email belongs to another GRIDGO identity. Resolve the identity conflict before bootstrap.");
    }

    const at = now();
    const administrator = linked || {
      id: createId("user"),
      clerkUserId,
      email: profile.email,
      name: profile.name || profile.email.split("@")[0],
      createdAt: at,
    };
    administrator.role = "super_admin";
    delete administrator.accountType;
    delete administrator.orgName;
    if (profile.phone) administrator.phone = profile.phone;
    if (!linked) store.users.push(administrator);
    store.auditLog.push({
      id: createId("aud"),
      at,
      actorId: administrator.id,
      actorRole: "super_admin",
      action: "administrator.bootstrap",
      entityType: "user",
      entityId: administrator.id,
      orderId: null,
      detail: { clerkUserId },
      reason: "One-time initial administrator bootstrap",
    });
    await saveStore(database, store);
    await database.query(
      `INSERT INTO administrator_bootstrap (singleton, completed_at, administrator_id)
       VALUES (true, $1, $2)`,
      [at, administrator.id],
    );
    return administrator;
  });
}

function clerkUserIdArgument(argv) {
  const direct = argv.find((value) => value.startsWith("--clerk-user-id="));
  if (direct) return direct.slice("--clerk-user-id=".length);
  const index = argv.indexOf("--clerk-user-id");
  return index >= 0 ? argv[index + 1] : null;
}

async function main() {
  const clerkUserId = clerkUserIdArgument(process.argv.slice(2));
  if (!clerkUserId) throw new Error("Usage: npm run bootstrap-admin -- --clerk-user-id <Clerk user id>");
  const config = authConfiguration(process.env);
  const database = createDatabase(process.env);
  try {
    await database.assertReady();
    const administrator = await bootstrapAdministrator({
      database,
      clerkBackend: createClerkBackend(config),
      clerkUserId,
    });
    console.log(`Bootstrapped GRIDGO administrator ${administrator.id}.`);
  } finally {
    await database.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
