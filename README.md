[![Package on npm](https://img.shields.io/npm/v/postgraphile-plugin-fulltext-filter.svg)](https://www.npmjs.com/package/postgraphile-plugin-fulltext-filter)
[![CircleCI](https://circleci.com/gh/mlipscombe/postgraphile-plugin-fulltext-filter/tree/master.svg?style=svg)](https://circleci.com/gh/mlipscombe/postgraphile-plugin-fulltext-filter/tree/master)

# postgraphile-plugin-fulltext-filter

This plugin implements a full text search operator for `tsvector` columns in
PostGraphile v5 via @mattbretl's excellent
`postgraphile-plugin-connection-filter` plugin.

## Getting Started

Add it to your `graphile.config.ts` file:

```ts
import { PostGraphileAmberPreset } from "postgraphile/presets/amber";
import { PostGraphileConnectionFilterPreset } from "postgraphile-plugin-connection-filter";
import {
  PgFulltextFilterPlugin,
  PgFulltextExposePlugin,
} from "postgraphile-plugin-fulltext-filter";

const config: GraphileConfig.Preset = {
  extends: [AmberPreset, PostGraphileConnectionFilterPlugin],
  plugins: [
    PgFulltextFilterPlugin,

    /*
     * Uncomment this to expose the `FullText` fields for
     * select/insert/update/condition/orderBy. Not recommended,
     * instead you should selectively expose just the few fields/behaviors you
     * want via `@behavior` smart tags.
     */
    // PgFulltextExposePlugin,
  ],
};
```

## Performance

All `tsvector` columns that aren't @omit'd should have indexes on them:

```sql
ALTER TABLE posts ADD COLUMN full_text tsvector;
CREATE INDEX full_text_idx ON posts USING gin(full_text);
```

## Operators

This plugin adds the `matches` filter operator to the filter plugin, accepting a
GraphQL String input and using the `@@` operator to perform full-text searches
on `tsvector` columns.

This plugin uses [pg-tsquery](https://github.com/caub/pg-tsquery) to parse the
user input to prevent Postgres throwing on bad user input unnecessarily.

## Fields

For each `tsvector` column, a rank column will be automatically added to the
GraphQL type for the table by appending `Rank` to the end of the column's name.
For example, a column `full_text` will appear as `fullText` in the GraphQL type,
and a second column, `fullTextRank` will be added to the type as a `Float`.

This rank field can be used for ordering and is automatically added to the
orderBy enum for the table.

## Examples

```graphql
query {
  allPosts(
    filter: {
      fullText: { matches: 'foo -bar' }
    }
    orderBy: FULL_TEXT_RANK_DESC
  }) {
    ...
    fullTextRank
  }
}
```

## Contributing

Run the tests with:

```sh
yarn
createdb postgraphile_plugin_fulltext_filter || true
echo 'export TEST_DATABASE_URL="postgres:///postgraphile_plugin_fulltext_filter"' >> .env
chmod +x .env
yarn test
```
