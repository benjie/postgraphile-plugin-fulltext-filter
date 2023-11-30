import type {
  PgCodecWithAttributes,
  PgResource,
  PgResourceParameter,
  PgRegistry,
} from "@dataplan/pg";
declare global {
  namespace GraphileBuild {
    interface Inflection {
      fullTextScalarTypeName(): string;
      pgTsvRank(fieldName: string): string;
      pgTsvOrderByColumnRankEnum(
        codec: PgCodecWithAttributes,
        attributeName: string,
        ascending: boolean,
      ): string;
      pgTsvOrderByComputedColumnRankEnum(
        table: PgCodecWithAttributes,
        resource: PgResource<
          string,
          any,
          never,
          readonly PgResourceParameter[],
          PgRegistry<any, any, any>
        >,
        ascending: boolean,
      ): string;
    }
    interface ScopeScalar {
      isPgFullTextType?: boolean;
    }
  }
}

export { PostGraphileFulltextFilterPlugin } from "./PostgraphileFullTextFilterPlugin.js";
