// @ts-check

/* eslint-disable no-param-reassign */
const pg = require("pg");
const { readFile } = require("fs/promises");
const { makeSchema } = require("postgraphile");
const { makeV4Preset } = require("postgraphile/presets/v4");
const {
  makePgService,
  makeWithPgClientViaPgClientAlreadyInTransaction,
} = require("postgraphile/adaptors/pg");
const {
  PostGraphileConnectionFilterPreset,
} = require("postgraphile-plugin-connection-filter");
const { default: ThisPlugin } = require("../dist/index.js");

// This test suite can be flaky. Increase it’s timeout.
jest.setTimeout(1000 * 20);

const connectionString =
  process.env.TEST_DATABASE_URL ||
  "postgres:///postgraphile_plugin_fulltext_filter";

let pool;
beforeAll(() => {
  pool = new pg.Pool({ connectionString });
  pool.on("error", () => {});
  pool.on("connect", (client) => client.on("error", () => {}));
});

afterAll(() => {
  pool?.end();
});

/** @type {<T>(fn: (client: import("pg").PoolClient) => Promise<T> | T) => Promise<T>} */
const withPgClient = async (fn) => {
  let client;
  try {
    client = await pool.connect();
    await client.query("begin");
    await client.query("set local timezone to '+04:00'");
    const result = await fn(client);
    await client.query("rollback");
    return result;
  } finally {
    try {
      await client.release();
    } catch (e) {
      console.error("Error releasing pgClient", e);
    }
  }
};

/** @type {<T>(fn: (client: import("pg").PoolClient) => Promise<T> | T) => Promise<T>} */
const withRootDb = (fn) =>
  withPgClient(async (client) => {
    try {
      await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE;");
      return fn(client);
    } finally {
      await client.query("COMMIT;");
    }
  });

/** @type {(Promise<void> & {resolve: () => void, reject: () => void, client: import('pg').PoolClient, vars: any}) | null} */
let prepopulatedDBKeepalive;

/** @type {(client: import("pg").PoolClient) => Promise<{}>} */
const populateDatabase = async (client) => {
  await client.query(await readFile(`${__dirname}/data.sql`, "utf8"));
  return {};
};

/** @type {{(fn: (client: import("pg").PoolClient, vars: any) => Promise<void>): Promise<void>, setup: (fn: (e?: Error) => void) => Promise<void>, teardown(): void}} */
const withPrepopulatedDb = async (fn) => {
  if (!prepopulatedDBKeepalive) {
    throw new Error("You must call setup and teardown to use this");
  }
  const { client, vars } = prepopulatedDBKeepalive;
  if (!vars) {
    throw new Error("No prepopulated vars");
  }
  let err;
  try {
    await fn(client, vars);
  } catch (e) {
    err = e;
  }
  try {
    await client.query("ROLLBACK TO SAVEPOINT pristine;");
  } catch (e) {
    err = err || e;
    console.error("ERROR ROLLING BACK", /** @type{any} */ (e)?.message); // eslint-disable-line no-console
  }
  if (err) {
    throw err;
  }
};

withPrepopulatedDb.setup = (done) => {
  if (prepopulatedDBKeepalive) {
    throw new Error("There's already a prepopulated DB running");
  }
  let res;
  let rej;
  return withRootDb(async (client) => {
    prepopulatedDBKeepalive = Object.assign(
      new Promise((resolve, reject) => {
        res = resolve;
        rej = reject;
      }),
      { resolve: res, reject: rej, client, vars: undefined },
    );
    try {
      prepopulatedDBKeepalive.vars = await populateDatabase(client);
    } catch (err) {
      const e = /** @type {Error} */ (err);
      console.error("FAILED TO PREPOPULATE DB!", e.message); // eslint-disable-line no-console
      return done(e);
    }
    await client.query("SAVEPOINT pristine;");
    done();
    return prepopulatedDBKeepalive;
  });
};

withPrepopulatedDb.teardown = () => {
  if (!prepopulatedDBKeepalive) {
    throw new Error("Cannot tear down null!");
  }
  prepopulatedDBKeepalive.resolve(); // Release DB transaction
  prepopulatedDBKeepalive = null;
};

/** @type {GraphileConfig.Plugin} */
const ShoveClientIntoContextPlugin = {
  name: "ShoveClientIntoContextPlugin",

  grafast: {
    middleware: {
      prepareArgs(next, event) {
        const pgClient = event.args.contextValue.pgClient;
        if (pgClient) {
          event.args.contextValue.withPgClient =
            makeWithPgClientViaPgClientAlreadyInTransaction(pgClient, true);
        }
        return next();
      },
    },
  },
};

/** @type {(blah: {setup?: string | ((client: import("pg").PoolClient) => Promise<void>), test: (stuff:{schema: import("postgraphile/graphql").GraphQLSchema,resolvedPreset: GraphileConfig.ResolvedPreset, pgClient: import("pg").PoolClient}) => Promise<void>, options?: import("postgraphile/presets/v4").V4Options}) => () => Promise<void>} */
const withSchema =
  ({ setup, test, options = {} }) =>
  () =>
    withPgClient(async (client) => {
      if (setup) {
        if (typeof setup === "function") {
          await setup(client);
        } else {
          await client.query(setup);
        }
      }

      /** @type {GraphileConfig.Preset} */
      const preset = {
        extends: [
          makeV4Preset({
            // showErrorStack: true,
            ...options,
          }),
          PostGraphileConnectionFilterPreset,
        ],
        plugins: [ThisPlugin, ShoveClientIntoContextPlugin],
        pgServices: [
          makePgService({
            pool,
            schemas: ["fulltext_test"],
          }),
        ],
      };

      const { schema, resolvedPreset } = await makeSchema(preset);
      return test({
        schema,
        resolvedPreset,
        pgClient: client,
      });
    });

/** @type {(fn: string) => Promise<string>} */
const loadQuery = (fn) =>
  readFile(`${__dirname}/fixtures/queries/${fn}`, "utf8");

exports.withRootDb = withRootDb;
exports.withPrepopulatedDb = withPrepopulatedDb;
exports.withPgClient = withPgClient;
exports.withSchema = withSchema;
exports.loadQuery = loadQuery;
