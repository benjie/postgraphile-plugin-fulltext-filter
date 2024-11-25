// @ts-check
const { lexicographicSortSchema } = require("graphql");
const { isAsyncIterable, grafast } = require("postgraphile/grafast");
const { withSchema } = require("./helpers");

test(
  "table with unfiltered full-text field works",
  withSchema({
    setup: `
      create table fulltext_test.job (
        id serial primary key,
        name text not null,
        full_text tsvector
      );
      insert into fulltext_test.job (name, full_text) values 
        ('test', to_tsvector('apple fruit')), 
        ('test 2', to_tsvector('banana fruit'));
    `,
    test: async ({ schema, resolvedPreset, pgClient }) => {
      const source = `
        query {
          allJobs {
            nodes {
              id
              name
            }
          }
        }
      `;
      expect(lexicographicSortSchema(schema)).toMatchSnapshot();

      const result = await grafast({
        schema,
        source,
        contextValue: { pgClient },
        resolvedPreset,
        requestContext: {},
      });
      if (isAsyncIterable(result)) {
        throw new Error(`Didn't expect an async iterable`);
      }
      expect(result).not.toHaveProperty("errors");
    },
  }),
);

test(
  "fulltext search field is created (1)",
  withSchema({
    setup: `
      create table fulltext_test.job (
        id serial primary key,
        name text not null,
        full_text tsvector
      );
      insert into fulltext_test.job (name, full_text) values 
        ('test', to_tsvector('apple fruit')), 
        ('test 2', to_tsvector('banana fruit'));
    `,
    test: async ({ schema, resolvedPreset, pgClient }) => {
      const source = `
        query {
          allJobs(
            filter: {
              fullText: {
                matches: "fruit"
              }
            }
            orderBy: [
              FULL_TEXT_RANK_ASC 
            ]
          ) {
            nodes {
              id
              name
              fullTextRank
            }
          }
        }
      `;
      expect(lexicographicSortSchema(schema)).toMatchSnapshot();

      const result = await grafast({
        schema,
        source,
        contextValue: { pgClient },
        resolvedPreset,
        requestContext: {},
      });
      if (isAsyncIterable(result)) {
        throw new Error(`Didn't expect an async iterable`);
      }
      expect(result).not.toHaveProperty("errors");

      const data = result.data.allJobs.nodes;
      expect(data).toHaveLength(2);
      data.map((n) => expect(n.fullTextRank).not.toBeNull());

      const bananaQuery = `
        query {
          allJobs(
            filter: {
              fullText: {
                matches: "banana"
              }
            }
          ) {
            nodes {
              id
              name
              fullTextRank
            }
          }
        }
      `;
      const bananaResult = await grafast({
        schema,
        source: bananaQuery,
        contextValue: {
          pgClient,
        },
        resolvedPreset,
        requestContext: {},
      });
      if (isAsyncIterable(result)) {
        throw new Error(`Didn't expect an async iterable`);
      }
      expect(bananaResult).not.toHaveProperty("errors");

      const bananaData = bananaResult.data.allJobs.nodes;
      expect(bananaData).toHaveLength(1);
      bananaData.map((n) => expect(n.fullTextRank).not.toBeNull());
    },
  }),
);

test(
  "querying rank without filter works",
  withSchema({
    setup: `
      create table fulltext_test.job (
        id serial primary key,
        name text not null,
        full_text tsvector
      );
      insert into fulltext_test.job (name, full_text) values 
        ('test', to_tsvector('apple fruit')), 
        ('test 2', to_tsvector('banana fruit'));
    `,
    test: async ({ schema, resolvedPreset, pgClient }) => {
      const query = `
        query {
          allJobs {
            nodes {
              id
              name
              fullTextRank
            }
          }
        }
      `;
      expect(lexicographicSortSchema(schema)).toMatchSnapshot();

      const result = await grafast({
        schema,
        source: query,
        contextValue: { pgClient },
        resolvedPreset,
        requestContext: {},
      });
      if (isAsyncIterable(result)) {
        throw new Error(`Didn't expect an async iterable`);
      }
      expect(result).not.toHaveProperty("errors");

      const data = result.data.allJobs.nodes;
      expect(data).toHaveLength(2);
      data.map((n) => expect(n.fullTextRank).toBeNull());
    },
  }),
);

test(
  "fulltext search field is created",
  withSchema({
    setup: `
      create table fulltext_test.job (
        id serial primary key,
        name text not null,
        full_text tsvector,
        other_full_text tsvector
      );
      insert into fulltext_test.job (name, full_text, other_full_text) values 
        ('test', to_tsvector('apple fruit'), to_tsvector('vegetable potato')), 
        ('test 2', to_tsvector('banana fruit'), to_tsvector('vegetable pumpkin'));
    `,
    test: async ({ schema, resolvedPreset, pgClient }) => {
      const query = `
        query {
          allJobs(
            filter: {
              fullText: {
                matches: "fruit"
              }
              otherFullText: {
                matches: "vegetable"
              }
            }
            orderBy: [
              FULL_TEXT_RANK_ASC
              OTHER_FULL_TEXT_DESC
            ]
          ) {
            nodes {
              id
              name
              fullTextRank
              otherFullTextRank
            }
          }
        }
      `;
      expect(lexicographicSortSchema(schema)).toMatchSnapshot();

      const result = await grafast({
        schema,
        source: query,
        contextValue: { pgClient },
        resolvedPreset,
        requestContext: {},
      });
      if (isAsyncIterable(result)) {
        throw new Error(`Didn't expect an async iterable`);
      }
      expect(result).not.toHaveProperty("errors");

      const data = result.data.allJobs.nodes;
      expect(data).toHaveLength(2);
      data.map((n) => expect(n.fullTextRank).not.toBeNull());
      data.map((n) => expect(n.otherFullTextRank).not.toBeNull());

      const potatoQuery = `
        query {
          allJobs(
            filter: {
              otherFullText: {
                matches: "potato"
              }
            }
          ) {
            nodes {
              id
              name
              fullTextRank
              otherFullTextRank
            }
          }
        }
      `;
      const potatoResult = await grafast({
        schema,
        source: potatoQuery,
        contextValue: {
          pgClient,
        },
        resolvedPreset,
        requestContext: {},
      });
      if (isAsyncIterable(result)) {
        throw new Error(`Didn't expect an async iterable`);
      }
      expect(potatoResult).not.toHaveProperty("errors");

      const potatoData = potatoResult.data.allJobs.nodes;
      expect(potatoData).toHaveLength(1);
      potatoData.map((n) => expect(n.fullTextRank).toBeNull());
      potatoData.map((n) => expect(n.otherFullTextRank).not.toBeNull());
    },
  }),
);

test(
  "sort by full text rank field works",
  withSchema({
    setup: `
      create table fulltext_test.job (
        id serial primary key,
        name text not null,
        full_text tsvector
      );
      insert into fulltext_test.job (name, full_text) values 
        ('test', to_tsvector('apple fruit')), 
        ('test 2', to_tsvector('banana fruit'));
    `,
    test: async ({ schema, resolvedPreset, pgClient }) => {
      const query = `
        query orderByQuery($orderBy: [JobsOrderBy!]!) {
          allJobs(
            filter: {
              fullText: {
                matches: "fruit | banana"
              }
            }
            orderBy: $orderBy
          ) {
            nodes {
              id
              name
              fullTextRank
            }
          }
        }
      `;
      expect(lexicographicSortSchema(schema)).toMatchSnapshot();

      const ascResult = await grafast({
        schema,
        source: query,
        rootValue: { pgClient },
        variableValues: { orderBy: ["FULL_TEXT_ASC"] },
      });
      if (isAsyncIterable(result)) {
        throw new Error(`Didn't expect an async iterable`);
      }
      expect(ascResult).not.toHaveProperty("errors");

      const descResult = await grafast({
        schema,
        source: query,
        contextValue: { pgClient },
        variableValues: { orderBy: ["FULL_TEXT_DESC"] },
        resolvedPreset,
        requestContext: {},
      });
      if (isAsyncIterable(result)) {
        throw new Error(`Didn't expect an async iterable`);
      }
      expect(descResult).not.toHaveProperty("errors");

      expect(ascResult).not.toEqual(descResult);
    },
  }),
);

test(
  "works with connectionFilterRelations",
  withSchema({
    options: {
      graphileBuildOptions: {
        connectionFilterRelations: true,
      },
    },
    setup: `
      create table fulltext_test.clients (
        id serial primary key,
        comment text,
        tsv tsvector
      );
      
      create table fulltext_test.orders (
        id serial primary key,
        client_id integer references fulltext_test.clients (id),
        comment text,
        tsv tsvector
      );
      
      insert into fulltext_test.clients (id, comment, tsv) values
        (1, 'Client A', tsvector('fruit apple')),
        (2, 'Client Z', tsvector('fruit avocado'));
      
      insert into fulltext_test.orders (id, client_id, comment, tsv) values
        (1, 1, 'X', tsvector('fruit apple')),
        (2, 1, 'Y', tsvector('fruit pear apple')),
        (3, 1, 'Z', tsvector('vegetable potato')),
        (4, 2, 'X', tsvector('fruit apple')),
        (5, 2, 'Y', tsvector('fruit tomato')),
        (6, 2, 'Z', tsvector('vegetable'));
    `,
    test: async ({ schema, resolvedPreset, pgClient }) => {
      const query = `
        query {
          allOrders(filter: {
            or: [
              { comment: { includes: "Z"} },
              { clientByClientId: { tsv: { matches: "apple" } } }
            ]
          }) {
            nodes {
              id
              comment
              clientByClientId {
                id
                comment
              }
            }
          }
        }
      `;
      expect(lexicographicSortSchema(schema)).toMatchSnapshot();

      const result = await grafast({
        schema,
        source: query,
        contextValue: { pgClient },
        resolvedPreset,
        requestContext: {},
      });
      if (isAsyncIterable(result)) {
        throw new Error(`Didn't expect an async iterable`);
      }
      expect(result).not.toHaveProperty("errors");
      expect(result.data.allOrders.nodes).toHaveLength(2);
    },
  }),
);

test(
  "works with connectionFilterRelations with no local filter",
  withSchema({
    options: {
      graphileBuildOptions: {
        connectionFilterRelations: true,
      },
    },
    setup: `
      create table fulltext_test.clients (
        id serial primary key,
        comment text,
        tsv tsvector
      );
      
      create table fulltext_test.orders (
        id serial primary key,
        client_id integer references fulltext_test.clients (id),
        comment text,
        tsv tsvector
      );
      
      insert into fulltext_test.clients (id, comment, tsv) values
        (1, 'Client A', tsvector('fruit apple')),
        (2, 'Client Z', tsvector('fruit avocado'));
      
      insert into fulltext_test.orders (id, client_id, comment, tsv) values
        (1, 1, 'X', tsvector('fruit apple')),
        (2, 1, 'Y', tsvector('fruit pear apple')),
        (3, 1, 'Z', tsvector('vegetable potato')),
        (4, 2, 'X', tsvector('fruit apple')),
        (5, 2, 'Y', tsvector('fruit tomato')),
        (6, 2, 'Z', tsvector('vegetable'));
    `,
    test: async ({ schema, resolvedPreset, pgClient }) => {
      const source = `
        query {
          allOrders(filter: {
            clientByClientId: { tsv: { matches: "avocado" } }
          }) {
            nodes {
              id
              comment
              tsv
              clientByClientId {
                id
                comment
                tsv
              }
            }
          }
        }
      `;
      expect(lexicographicSortSchema(schema)).toMatchSnapshot();

      const result = await grafast({
        schema,
        source,
        contextValue: { pgClient },
        resolvedPreset,
        requestContext: {},
      });
      if (isAsyncIterable(result)) {
        throw new Error(`Didn't expect an async iterable`);
      }
      expect(result).not.toHaveProperty("errors");
      expect(result.data.allOrders.nodes).toHaveLength(3);
    },
  }),
);
