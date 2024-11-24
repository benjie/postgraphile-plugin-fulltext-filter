import { Tsquery } from "pg-tsquery";
import type {} from "postgraphile";
import type {
  PgCodecWithAttributes,
  PgResource,
  PgResourceParameter,
} from "postgraphile/@dataplan/pg";

declare global {
  namespace GraphileBuild {
    interface Inflection {
      fullTextScalarTypeName(this: Inflection): string;
      pgTsvRank(this: Inflection, fieldName: string): string;
      pgTsvOrderByColumnRankEnum(
        this: Inflection,
        codec: PgCodecWithAttributes,
        attributeName: string,
        ascending: boolean,
      ): string;
      pgTsvOrderByComputedColumnRankEnum(
        this: Inflection,
        codec: PgCodecWithAttributes,
        resource: PgResource<any, any, any, PgResourceParameter[], any>,
        ascending: boolean,
      ): string;
    }
  }
}

const tsquery = new Tsquery();

const PostGraphileFulltextFilterPlugin: GraphileConfig.Plugin = {
  name: "PostGraphileFulltextFilterPlugin",
  inflection: {
    add: {
      fullTextScalarTypeName() {
        return "FullText";
      },
      pgTsvRank(preset, fieldName) {
        return this.camelCase(`${fieldName}-rank`);
      },
      pgTsvOrderByColumnRankEnum(preset, codec, attributeName, ascending) {
        const columnName = this._attributeName({
          codec,
          attributeName,
          skipRowId: true,
        });
        return this.constantCase(
          `${columnName}_rank_${ascending ? "asc" : "desc"}`,
        );
      },
      pgTsvOrderByComputedColumnRankEnum(preset, codec, resource, ascending) {
        const columnName = this.computedAttributeField({
          resource,
        });
        return this.constantCase(
          `${columnName}_rank_${ascending ? "asc" : "desc"}`,
        );
      },
    },
  },

  schema: {
    hooks: {
      init(_, build) {
        const {
          addConnectionFilterOperator,
          sql,
          graphql: { GraphQLString },
          grafast: { lambda },
          inflection,
        } = build;

        if (!(addConnectionFilterOperator instanceof Function)) {
          throw new Error(
            "PostGraphileFulltextFilterPlugin requires PostGraphileConnectionFilterPlugin to be loaded before it.",
          );
        }

        const scalarName = inflection.fullTextScalarTypeName();
        build.registerScalarType(
          scalarName,
          {},
          () => ({
            serialize(value) {
              return value;
            },
            parseValue(value) {
              return value;
            },
            parseLiteral(lit) {
              return lit;
            },
          }),
          "Adding full text scalar type",
        );

        const tsvectorCodecs = [...build.allPgCodecs].filter(
          (c) =>
            c.extensions?.pg?.schemaName === "pg_catalog" &&
            c.extensions?.pg?.name === "tsvector",
        );

        for (const tsvectorCodec of tsvectorCodecs) {
          build.setGraphQLTypeForPgCodec(
            tsvectorCodec,
            ["input", "output"],
            scalarName,
          );
        }

        addConnectionFilterOperator(scalarName, "matches", {
          description: "Performs a full text search on the field.",
          resolveType: () => GraphQLString,
          resolve(sqlIdentifier, sqlValue, $input, $placeholderable) {
            const $tsQueryString = lambda(
              $input,
              (input) => `${tsquery.parse(input) || ""}`,
              true,
            );
            // queryBuilder.__fts_ranks = queryBuilder.__fts_ranks || {};
            // queryBuilder.__fts_ranks[fieldName] = [identifier, tsQueryString];
            return sql.query`${sqlIdentifier} @@ to_tsquery(${sql.value(tsQueryString)})`;
          },
        });

        return _;
      },

      GraphQLObjectType_fields(fields, build, context) {
        const {
          pgIntrospectionResultsByKind: introspectionResultsByKind,
          graphql: { GraphQLFloat },
          pgColumnFilter,
          pg2gql,
          pgSql: sql,
          inflection,
          pgTsvType,
        } = build;

        const {
          scope: { isPgRowType, isPgCompoundType, pgIntrospection: table },
          fieldWithHooks,
        } = context;

        if (
          !(isPgRowType || isPgCompoundType) ||
          !table ||
          table.kind !== "class" ||
          !pgTsvType
        ) {
          return fields;
        }

        const tableType = introspectionResultsByKind.type.filter(
          (type) =>
            type.type === "c" &&
            type.namespaceId === table.namespaceId &&
            type.classId === table.id,
        )[0];
        if (!tableType) {
          throw new Error("Could not determine the type of this table.");
        }

        const tsvColumns = table.attributes
          .filter((attr) => attr.typeId === pgTsvType.id)
          .filter((attr) => pgColumnFilter(attr, build, context))
          .filter((attr) => !omit(attr, "filter"));

        const tsvProcs = introspectionResultsByKind.procedure
          .filter((proc) => proc.isStable)
          .filter((proc) => proc.namespaceId === table.namespaceId)
          .filter((proc) => proc.name.startsWith(`${table.name}_`))
          .filter((proc) => proc.argTypeIds.length > 0)
          .filter((proc) => proc.argTypeIds[0] === tableType.id)
          .filter((proc) => proc.returnTypeId === pgTsvType.id)
          .filter((proc) => !omit(proc, "filter"));

        if (tsvColumns.length === 0 && tsvProcs.length === 0) {
          return fields;
        }

        const newRankField = (baseFieldName, rankFieldName) =>
          fieldWithHooks(
            rankFieldName,
            ({ addDataGenerator }) => {
              addDataGenerator(({ alias }) => ({
                pgQuery: (queryBuilder) => {
                  const { parentQueryBuilder } = queryBuilder;
                  if (
                    !parentQueryBuilder ||
                    !parentQueryBuilder.__fts_ranks ||
                    !parentQueryBuilder.__fts_ranks[baseFieldName]
                  ) {
                    return;
                  }
                  const [identifier, tsQueryString] =
                    parentQueryBuilder.__fts_ranks[baseFieldName];
                  queryBuilder.select(
                    sql.fragment`ts_rank(${identifier}, to_tsquery(${sql.value(tsQueryString)}))`,
                    alias,
                  );
                },
              }));
              return {
                description: `Full-text search ranking when filtered by \`${baseFieldName}\`.`,
                type: GraphQLFloat,
                resolve: (data) => pg2gql(data[rankFieldName], GraphQLFloat),
              };
            },
            {
              isPgTSVRankField: true,
            },
          );

        const tsvFields = tsvColumns.reduce((memo, attr) => {
          const fieldName = inflection.column(attr);
          const rankFieldName = inflection.pgTsvRank(fieldName);
          memo[rankFieldName] = newRankField(fieldName, rankFieldName); // eslint-disable-line no-param-reassign

          return memo;
        }, {});

        const tsvProcFields = tsvProcs.reduce((memo, proc) => {
          const psuedoColumnName = proc.name.substr(table.name.length + 1);
          const fieldName = inflection.computedColumn(
            psuedoColumnName,
            proc,
            table,
          );
          const rankFieldName = inflection.pgTsvRank(fieldName);
          memo[rankFieldName] = newRankField(fieldName, rankFieldName); // eslint-disable-line no-param-reassign

          return memo;
        }, {});

        return Object.assign({}, fields, tsvFields, tsvProcFields);
      },

      GraphQLEnumType_values(values, build, context) {
        const {
          extend,
          pgSql: sql,
          pgColumnFilter,
          pgIntrospectionResultsByKind: introspectionResultsByKind,
          inflection,
          pgTsvType,
        } = build;

        const {
          scope: { isPgRowSortEnum, pgIntrospection: table },
        } = context;

        if (
          !isPgRowSortEnum ||
          !table ||
          table.kind !== "class" ||
          !pgTsvType
        ) {
          return values;
        }

        const tableType = introspectionResultsByKind.type.filter(
          (type) =>
            type.type === "c" &&
            type.namespaceId === table.namespaceId &&
            type.classId === table.id,
        )[0];
        if (!tableType) {
          throw new Error("Could not determine the type of this table.");
        }

        const tsvColumns = introspectionResultsByKind.attribute
          .filter((attr) => attr.classId === table.id)
          .filter((attr) => attr.typeId === pgTsvType.id);

        const tsvProcs = introspectionResultsByKind.procedure
          .filter((proc) => proc.isStable)
          .filter((proc) => proc.namespaceId === table.namespaceId)
          .filter((proc) => proc.name.startsWith(`${table.name}_`))
          .filter((proc) => proc.argTypeIds.length === 1)
          .filter((proc) => proc.argTypeIds[0] === tableType.id)
          .filter((proc) => proc.returnTypeId === pgTsvType.id)
          .filter((proc) => !omit(proc, "order"));

        if (tsvColumns.length === 0 && tsvProcs.length === 0) {
          return values;
        }

        return extend(
          values,
          tsvColumns
            .concat(tsvProcs)
            .filter((attr) => pgColumnFilter(attr, build, context))
            .filter((attr) => !omit(attr, "order"))
            .reduce((memo, attr) => {
              const fieldName =
                attr.kind === "procedure"
                  ? inflection.computedColumn(
                      attr.name.substr(table.name.length + 1),
                      attr,
                      table,
                    )
                  : inflection.column(attr);
              const ascFieldName = inflection.pgTsvOrderByColumnRankEnum(
                table,
                attr,
                true,
              );
              const descFieldName = inflection.pgTsvOrderByColumnRankEnum(
                table,
                attr,
                false,
              );

              const findExpr = ({ queryBuilder }) => {
                if (
                  !queryBuilder.__fts_ranks ||
                  !queryBuilder.__fts_ranks[fieldName]
                ) {
                  return sql.fragment`1`;
                }
                const [identifier, tsQueryString] =
                  queryBuilder.__fts_ranks[fieldName];
                return sql.fragment`ts_rank(${identifier}, to_tsquery(${sql.value(tsQueryString)}))`;
              };

              memo[ascFieldName] = {
                // eslint-disable-line no-param-reassign
                value: {
                  alias: `${ascFieldName.toLowerCase()}`,
                  specs: [[findExpr, true]],
                },
              };
              memo[descFieldName] = {
                // eslint-disable-line no-param-reassign
                value: {
                  alias: `${descFieldName.toLowerCase()}`,
                  specs: [[findExpr, false]],
                },
              };

              return memo;
            }, {}),
          `Adding TSV rank columns for sorting on table '${table.name}'`,
        );
      },
    },
  },
};

export default PostGraphileFulltextFilterPlugin;

// HACK: for TypeScript/Babel import
module.exports = PostGraphileFulltextFilterPlugin;
module.exports.default = PostGraphileFulltextFilterPlugin;
Object.defineProperty(module.exports, "__esModule", { value: true });
