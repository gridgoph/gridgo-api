import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../src/database.js";
import { up } from "../migrations/1795452000000_product_templates.js";

// The migration must extend the installed policy, including rows already using
// a reference type introduced by another release. Test the real DDL in a private
// schema so the normal public test database remains fully migrated.
test(
  "template migration preserves installed reference types and populated team-photo references",
  { skip: !process.env.DATABASE_URL },
  async (t) => {
    const db = createDatabase(process.env);
    t.after(() => db.close());
    assert.match(new URL(process.env.DATABASE_URL).pathname, /test/);
    await db.transaction(async () => {
      await db.query("CREATE SCHEMA template_migration_regression");
      await db.query(
        "SET LOCAL search_path TO template_migration_regression,public",
      );
      await db.query(`CREATE TABLE supplier_catalog_options (sort_order smallint CONSTRAINT supplier_catalog_options_sort_order_check CHECK (sort_order BETWEEN 0 AND 19));
      CREATE TABLE supplier_catalog_items (id text PRIMARY KEY);
      CREATE TABLE file_references (reference_type text CONSTRAINT file_references_reference_type_check CHECK (reference_type IN ('order','shop_team_member','retained_extension')));
      INSERT INTO file_references(reference_type) VALUES ('shop_team_member'),('retained_extension');`);
      const sql = [];
      await up({ sql: (chunk) => sql.push(chunk) });
      for (const chunk of sql) await db.query(chunk);
      await db.query(
        "INSERT INTO file_references(reference_type) VALUES ('product_setup_request'),('shop_team_member'),('retained_extension')",
      );
      assert.deepEqual(
        (
          await db.query(
            "SELECT reference_type FROM file_references ORDER BY reference_type",
          )
        ).rows.map((row) => row.reference_type),
        [
          "product_setup_request",
          "retained_extension",
          "retained_extension",
          "shop_team_member",
          "shop_team_member",
        ],
      );
      await db.query("SAVEPOINT invalid_reference");
      await assert.rejects(
        db.query(
          "INSERT INTO file_references(reference_type) VALUES ('not_allowed')",
        ),
        { code: "23514" },
      );
      await db.query("ROLLBACK TO SAVEPOINT invalid_reference");
      await db.query(
        "INSERT INTO supplier_catalog_options(sort_order) VALUES (0),(19),(179),(199)",
      );
      await db.query("DROP SCHEMA template_migration_regression CASCADE");
    });
  },
);
