/**
 * Refuse to run the suite against a database that is not a test database.
 *
 * The tests truncate and rewrite whatever they are pointed at. `npm test` used
 * to resolve `DATABASE_URL=${DATABASE_URL:-...gridgo_test}`, which reads as a
 * safe default and is not one: an ambient `DATABASE_URL` wins, and `.env`
 * sets that to the development database. Sourcing the local environment before
 * running the suite therefore emptied the development board -- silently, twice,
 * and the resulting lock contention looked like a flaky deadlock rather than a
 * pointed gun.
 *
 * `npm test` now reads TEST_DATABASE_URL, which nothing else sets. This is the
 * backstop for the remaining case: somebody pointing TEST_DATABASE_URL at a
 * database they still want.
 */

const url = process.env.DATABASE_URL;

if (!url) {
  console.error("Refusing to run: no database was resolved for the test suite.");
  process.exit(1);
}

let name;
try {
  name = new URL(url).pathname.replace(/^\//, "");
} catch {
  console.error(`Refusing to run: DATABASE_URL is not a valid URL (${url.slice(0, 24)}...).`);
  process.exit(1);
}

// The suite destroys its database. Anything not named as a test database is
// assumed to be somebody's working data.
if (!/(^|[_-])test($|[_-])/.test(name)) {
  console.error(
    `Refusing to run the test suite against "${name}".\n`
    + "The suite truncates and rewrites every table in the database it is given,\n"
    + "and this one is not named as a test database.\n\n"
    + "Set TEST_DATABASE_URL to a database you are willing to lose, for example:\n"
    + "  TEST_DATABASE_URL=postgresql://gridgo:gridgo_dev@127.0.0.1:55439/gridgo_test npm test",
  );
  process.exit(1);
}
