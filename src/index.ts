import { Tsquery } from "pg-tsquery";
import type {} from "postgraphile";
import type { SQL } from "postgraphile/pg-sql2";
import type {
  PgCodec,
  PgCodecWithAttributes,
  PgResource,
  PgResourceParameter,
  PgSelectStep,
  PgSelectSingleStep,
} from "postgraphile/@dataplan/pg";
import type { ExecutableStep } from "postgraphile/grafast";

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
    interface ScopeObjectFieldsField {
      isPgTSVRankField?: boolean;
    }
  }
}

/**
 * DO NOT DO THIS!
 */
type HackedPgSelectStep = PgSelectStep & {
  __fts_ranks: Record<string, [identifier: SQL, value: SQL]>;
};

/*
 * Hacks on hacks on hacks... Don't do this because it breaks
 * normalized caching - we're only doing it to maintain backwards
 * compatibility.
 */
function getHackedStep(build: GraphileBuild.Build, $someStep: ExecutableStep) {
  const {
    dataplanPg: { PgConditionStep, PgSelectStep, PgSelectSingleStep },
  } = build;
  let $step = $someStep;
  while ($step instanceof PgConditionStep) {
    $step = ($step as any).$parent;
  }
  if ($step instanceof PgSelectSingleStep) {
    $step = $step.getClassStep();
  }
  if ($step instanceof PgSelectStep) {
    const $s = $step as HackedPgSelectStep;
    $s.__fts_ranks ??= Object.create(null);
    return $s;
  } else {
    console.log(`${$step} was not a PgSelectStep... unable to cache rank`);
    return null;
  }
}

const tsquery = new Tsquery();

function isTsvectorCodec(codec: PgCodec) {
  return (
    codec.extensions?.pg?.schemaName === "pg_catalog" &&
    codec.extensions?.pg?.name === "tsvector"
  );
}

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
          graphql: { GraphQLString, Kind },
          dataplanPg: { PgConditionStep, PgSelectStep },
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
              return String(value);
            },
            parseValue(value) {
              if (typeof value === "string") {
                return tsquery.parse(value) || "";
              } else {
                throw new Error(`${scalarName} must be a string`);
              }
            },
            parseLiteral(lit) {
              if (lit.kind === Kind.NULL) return null;
              if (lit.kind !== Kind.STRING) {
                throw new Error(`${scalarName} must be a string`);
              }
              return tsquery.parse(lit.value) || "";
            },
          }),
          "Adding full text scalar type",
        );

        const tsvectorCodecs = [...build.allPgCodecs].filter(isTsvectorCodec);

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
          resolve(
            sqlIdentifier,
            sqlValue,
            $input,
            $placeholderable,
            { fieldName },
          ) {
            // queryBuilder.__fts_ranks = queryBuilder.__fts_ranks || {};
            const $s = getHackedStep(build, $placeholderable as any);
            if ($s) {
              // queryBuilder.__fts_ranks[fieldName] = [identifier, tsQueryString];
              $s.__fts_ranks![fieldName] = [sqlIdentifier, sqlValue];
            }

            return sql.query`${sqlIdentifier} @@ to_tsquery(${sqlValue})`;
          },
        });

        return _;
      },

      GraphQLObjectType_fields(fields, build, context) {
        const {
          dataplanPg: { TYPES },
          grafast: { constant },
          graphql: { GraphQLFloat },
          input: { pgRegistry },
          sql,
          inflection,
          behavior,
        } = build;

        const {
          scope: {
            isPgClassType, // isPgRowType, isPgCompoundType,
            pgCodec: rawPgCodec,
          },
          fieldWithHooks,
        } = context;

        if (!isPgClassType || !rawPgCodec?.attributes) {
          return fields;
        }

        const codec = rawPgCodec as PgCodecWithAttributes;

        function addTsvField(
          baseFieldName: string,
          fieldName: string,
          origin: string,
        ) {
          build.extend(
            fields,
            {
              [fieldName]: fieldWithHooks(
                {
                  fieldName,
                  isPgTSVRankField: true,
                },
                () => {
                  return {
                    description: `Full-text search ranking when filtered by \`${baseFieldName}\`.`,
                    type: GraphQLFloat,
                    plan($step) {
                      const $row = $step as PgSelectSingleStep;
                      const $select = getHackedStep(build, $row);
                      const hack = $select?.__fts_ranks[baseFieldName];
                      if (!hack) {
                        return constant(null);
                      }
                      const [identifier, tsQueryString] = hack;
                      return $row.select(
                        sql.fragment`ts_rank(${identifier}, to_tsquery(${tsQueryString}))`,
                        TYPES.float,
                      );
                    },
                  };
                },
              ),
            },
            origin,
          );
        }

        for (const attributeName of Object.keys(codec.attributes)) {
          if (
            !behavior.pgCodecAttributeMatches([codec, attributeName], "filter")
          ) {
            continue;
          }

          const baseFieldName = inflection.attribute({ codec, attributeName });
          const fieldName = inflection.pgTsvRank(baseFieldName);
          addTsvField(
            baseFieldName,
            fieldName,
            `Adding rank field for ${attributeName}`,
          );
        }

        const tsvProcs = Object.values(pgRegistry.pgResources).filter(
          (r): r is PgResource<any, any, any, PgResourceParameter[], any> => {
            if (!isTsvectorCodec(r.codec)) return false;
            if (!r.parameters) return false;
            if (!r.parameters[0]) return false;
            if (r.parameters[0].codec !== codec) return false;
            if (!behavior.pgResourceMatches(r, "typeField")) return false;
            if (!behavior.pgResourceMatches(r, "filterBy")) return false;
            if (typeof r.from !== "function") return false;

            // Must have only one required argument
            // if (r.parameters.slice(1).some((p) => p.required)) return false

            return true;
          },
        );

        for (const resource of tsvProcs) {
          const baseFieldName = inflection.computedAttributeField({ resource });
          const fieldName = inflection.pgTsvRank(baseFieldName);
          addTsvField(
            baseFieldName,
            fieldName,
            `Adding rank field for computed column ${resource.name} on ${context.Self.name}`,
          );
        }

        return fields;
      },

      GraphQLEnumType_values(values, build, context) {
        const {
          extend,
          sql,
          inflection,
          input: { pgRegistry },
          behavior,
          dataplanPg: { TYPES },
        } = build;

        const {
          scope: { isPgRowSortEnum, pgCodec: rawPgCodec },
        } = context;

        if (!isPgRowSortEnum || !rawPgCodec || !rawPgCodec.attributes) {
          return values;
        }

        const codec = rawPgCodec as PgCodecWithAttributes;

        for (const [attributeName, attribute] of Object.entries(
          codec.attributes,
        )) {
          if (!isTsvectorCodec(attribute.codec)) continue;
          const fieldName = inflection.attribute({ codec, attributeName });
          const ascFieldName = inflection.pgTsvOrderByColumnRankEnum(
            codec,
            attributeName,
            true,
          );
          const descFieldName = inflection.pgTsvOrderByColumnRankEnum(
            codec,
            attributeName,
            false,
          );

          const makePlan =
            (direction: "ASC" | "DESC") => (step: PgSelectStep) => {
              const $select = getHackedStep(build, step);
              const hack = $select?.__fts_ranks[fieldName];
              if (hack) {
                const [identifier, tsQueryString] = hack;
                step.orderBy({
                  codec: TYPES.float,
                  fragment: sql.fragment`ts_rank(${identifier}, to_tsquery(${tsQueryString}))`,
                  direction,
                });
              }
            };

          build.extend(
            values,
            {
              [ascFieldName]: {
                extensions: {
                  grafast: {
                    applyPlan: makePlan("ASC"),
                  },
                },
              },
              [descFieldName]: {
                extensions: {
                  grafast: {
                    applyPlan: makePlan("DESC"),
                  },
                },
              },
            },
            `Adding orders for rank of ${attributeName} on ${context.Self.name}`,
          );
        }

        const tsvProcs = Object.values(pgRegistry.pgResources).filter(
          (r): r is PgResource<any, any, any, PgResourceParameter[], any> => {
            if (!isTsvectorCodec(r.codec)) return false;
            if (!r.parameters) return false;
            if (!r.parameters[0]) return false;
            if (r.parameters[0].codec !== codec) return false;
            if (!behavior.pgResourceMatches(r, "typeField")) return false;
            if (!behavior.pgResourceMatches(r, "orderBy")) return false;
            if (typeof r.from !== "function") return false;

            // Must have only one required argument
            // if (r.parameters.slice(1).some((p) => p.required)) return false

            return true;
          },
        );

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
                      attr.name.substr(codec.name.length + 1),
                      attr,
                      codec,
                    )
                  : inflection.column(attr);
              const ascFieldName = inflection.pgTsvOrderByColumnRankEnum(
                codec,
                attr,
                true,
              );
              const descFieldName = inflection.pgTsvOrderByColumnRankEnum(
                codec,
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
          `Adding TSV rank columns for sorting on table '${codec.name}'`,
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
