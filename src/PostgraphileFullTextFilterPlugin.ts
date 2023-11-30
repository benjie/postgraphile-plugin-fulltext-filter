import type {} from "graphile-config";
import type { GrafastInputFieldConfig, ExecutableStep } from "grafast";
import type {} from "postgraphile";
import type {} from "postgraphile-plugin-connection-filter";
import type { PgConditionStep } from "@dataplan/pg";
import tsqueryFactory from "pg-tsquery";

const tsquery = tsqueryFactory();

const { version } = require("../package.json");

export const PostGraphileFulltextFilterPlugin: GraphileConfig.Plugin = {
  name: "PostGraphileFulltextFilterPlugin",
  version,
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
      pgTsvOrderByComputedColumnRankEnum(preset, table, resource, ascending) {
        const columnName = this.computedAttributeField({ resource });
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
          inflection,
          input: { pgRegistry },
        } = build;

        const tsvectorCodec = pgRegistry.pgCodecs.tsvector;
        if (!tsvectorCodec) {
          return build.recoverable(_, () => {
            throw new Error(
              "Unable to find tsvector type through introspection.",
            );
          });
        }

        const scalarName = inflection.fullTextScalarTypeName();

        build.registerScalarType(
          scalarName,
          {
            isPgFullTextType: true,
          },
          () => ({
            // TODO: this does not seem like a full scalar implementation?
            serialize(value) {
              return value;
            },
            parseValue(value) {
              return value;
            },
            parseLiteral(lit) {
              if (lit.kind !== "StringValue") {
                throw new Error(`Invalid literal for '${scalarName}' scalar.`);
              } else {
                return lit.value;
              }
            },
          }),
          "Registering FullTextType from full-text filter plugin",
        );

        build.setGraphQLTypeForPgCodec(
          tsvectorCodec,
          ["input", "output"],
          scalarName,
        );

        return _;
      },

      GraphQLInputObjectType_fields(fields, build, context) {
        const {
          sql,
          graphql: { GraphQLString },
          grafast: { lambda },
        } = build;
        const {
          scope: { pgConnectionFilterOperators },
        } = context;

        if (!pgConnectionFilterOperators) {
          return fields;
        }

        if (pgConnectionFilterOperators.pgCodecs.length !== 1) {
          return fields;
        }

        const [tsvectorCodec] = pgConnectionFilterOperators.pgCodecs;
        if (tsvectorCodec.name !== "tsvector") {
          return fields;
        }

        return build.extend(
          fields,
          {
            matches: {
              type: build.getInputTypeByName("String"),
              applyPlan($fieldPlan, fieldArgs, info) {
                const $where = $fieldPlan as PgConditionStep<any>;
                if (!$where.extensions?.pgFilterAttribute) {
                  throw new Error(
                    `Planning error: expected 'pgFilterAttribute' to be present on the \$where plan's extensions; your extensions to \`postgraphile-plugin-connection-filter\` does not implement the required interfaces.`,
                  );
                }
                const $input = fieldArgs.getRaw();
                if ($input.evalIs(undefined)) {
                  return;
                }
                const { attributeName, attribute, codec, expression } =
                  $where.extensions.pgFilterAttribute;
                const $resolvedInput = lambda(
                  $input as ExecutableStep,
                  tsquery,
                );
                const inputCodec = codec ?? attribute.codec;

                const sourceAlias = attribute
                  ? attribute.expression
                    ? attribute.expression($where.alias)
                    : sql`${$where.alias}.${sql.identifier(attributeName)}`
                  : expression
                    ? expression
                    : $where.alias;
                const sqlValue = $where.placeholder($resolvedInput, inputCodec);
                return $fieldPlan.where(
                  sql`${sourceAlias} @@ to_tsquery(${sqlValue})`,
                );
              },
            } as GrafastInputFieldConfig<any, any, any, any, any>,
          },
          "Adding the 'matches' input field to the tsvector filter type.",
        );

        /*
        addConnectionFilterOperator(
          "matches",
          "Performs a full text search on the field.",
          () => GraphQLString,
          (identifier, val, input, fieldName, queryBuilder) => {
            queryBuilder.__fts_ranks = queryBuilder.__fts_ranks || {};
            queryBuilder.__fts_ranks[fieldName] = [identifier, tsQueryString];
            return sql.query`${identifier} @@ to_tsquery(${sql.value(
              tsQueryString,
            )})`;
          },
          {
            allowedFieldTypes: [InputType.name],
          },
        );
        */
      },

      /*
       * THIS CODE HAS BEEN DISABLED BECAUSE IT IS NOT VALID GRAPHQL! IT BREAKS
       * NORMALIZED CACHING! Instead, the rank should be added to an edge in the
       * connection or similar, rather than to the node itself.

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
                    sql.fragment`ts_rank(${identifier}, to_tsquery(${sql.value(
                      tsQueryString,
                    )}))`,
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
      */

      /*
       * This is also problematic, for example consider a filter such as
       * `filter: {and: [{ name: { matches: "bob" } }, { name: { matches: "smith" } }]}`.
       * Here we're filtering the same column twice... so we have two ranking
       * values... How do we order by that?
       *
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
                return sql.fragment`ts_rank(${identifier}, to_tsquery(${sql.value(
                  tsQueryString,
                )}))`;
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
      },*/
    },
  },
};
