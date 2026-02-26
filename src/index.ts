import { Tsquery } from "pg-tsquery";
import type {} from "postgraphile";
import type {} from "postgraphile-plugin-connection-filter";
import type { SQL } from "postgraphile/pg-sql2";
import type {
  PgCodec,
  PgCodecWithAttributes,
  PgResource,
  PgResourceParameter,
  PgSelectSingleStep,
  PgSelectQueryBuilder,
  PgConditionCapableParent,
} from "postgraphile/@dataplan/pg";
import type { Step, Maybe } from "postgraphile/grafast";

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
    interface BehaviorStrings {
      "attributeFtsRank:select": true;
      "procFtsRank:select": true;
      "attributeFtsRank:orderBy": true;
      "procFtsRank:orderBy": true;
    }
  }
  namespace GraphileConfig {
    interface Plugins {
      PostGraphileFulltextFilterPlugin: true;
    }

    interface GatherHelpers {
      pgFulltextFilter: {
        getTsvectorCodec(): PgCodec<string, any, any, any, undefined, any, any>;
        getTsvectorArrayCodec(): PgCodec;
      };
    }
  }
}

interface FtsRanksDetails {
  selectIndex: number;
  scoreFragment: SQL;
}

function isPgSelectQueryBuilder(
  o: Record<string, any>,
): o is PgSelectQueryBuilder {
  return (
    !!o.alias &&
    typeof o.where === "function" &&
    typeof o.havingBuilder === "function"
  );
}

/*
 * Hacks on hacks on hacks... Don't do this because it breaks
 * normalized caching - we're only doing it to maintain backwards
 * compatibility.
 */
function getQueryBuilder(
  build: GraphileBuild.Build,
  parent: PgConditionCapableParent,
): PgSelectQueryBuilder | null {
  const {
    dataplanPg: { PgCondition },
  } = build;
  let conditionOrQB: PgConditionCapableParent | PgSelectQueryBuilder = parent;
  const { alias } = conditionOrQB;
  while (
    conditionOrQB &&
    conditionOrQB instanceof PgCondition &&
    conditionOrQB.alias === alias
  ) {
    conditionOrQB = (conditionOrQB as any).parent;
  }
  if (isPgSelectQueryBuilder(conditionOrQB) && conditionOrQB.alias === alias) {
    return conditionOrQB;
  } else if (conditionOrQB instanceof PgCondition) {
    // alias didn't match
    return null;
  } else {
    console.warn(
      `%o was not a PgSelectQueryBuilder... unable to cache rank`,
      conditionOrQB,
    );
    return null;
  }
}

const tsquery = new Tsquery();

/**
 * This is a TypeScript constrained identity function to save having to specify
 * all the generics manually.
 */
export function gatherConfig<
  const TNamespace extends keyof GraphileConfig.GatherHelpers,
  const TState extends { [key: string]: any } = { [key: string]: any },
  const TCache extends { [key: string]: any } = { [key: string]: any },
>(
  config: GraphileConfig.PluginGatherConfig<TNamespace, TState, TCache>,
): GraphileConfig.PluginGatherConfig<TNamespace, TState, TCache> {
  return config;
}

export const PgFulltextFilterPlugin: GraphileConfig.Plugin = {
  name: "PgFulltextFilterPlugin",
  // Need to register our scalar before the main schema does
  before: ["PgCodecsPlugin"],
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
    behaviorRegistry: {
      add: {
        "attributeFtsRank:select": {
          description:
            "[NOT VALID GRAPHQL!] Should the 'full text search' rank be exposed for this attribute",
          entities: ["pgCodecAttribute"],
        },
        "procFtsRank:select": {
          description:
            "[NOT VALID GRAPHQL!] Should the 'full text search' derivative of this 'computed column' function be added?",
          entities: ["pgResource"],
        },
        "attributeFtsRank:orderBy": {
          description:
            "Should you be able to order by the FTS rank for this attribute?",
          entities: ["pgCodecAttribute"],
        },
        "procFtsRank:orderBy": {
          description:
            "Should you be able to order by the FTS rank for this 'computed column' function?",
          entities: ["pgResource"],
        },
      },
    },
    entityBehavior: {
      pgCodecAttribute: {
        inferred: {
          provides: ["default"],
          before: ["inferred", "override", "PgAttributesPlugin"],
          callback(behavior, [codec, attributeName], build) {
            const attr = codec.attributes[attributeName];
            if (attr.codec === build.dataplanPg.TYPES.tsvector) {
              // Core added:
              // -attribute:base -attribute:select -attribute:insert
              // -attribute:update -condition:attribute:filterBy
              // -attribute:orderBy
              return [
                "attributeFtsRank:orderBy",
                "attributeFtsRank:select",
                behavior,
              ];
            }
            return behavior;
          },
        },
      },
      pgResource: {
        inferred: {
          provides: ["default"],
          before: ["inferred", "override", "PgProceduresPlugin"],
          callback(behavior, resource, build) {
            if (!resource.parameters) {
              return behavior;
            }
            if (resource.codec !== build.dataplanPg.TYPES.tsvector) {
              return behavior;
            }
            return ["procFtsRank:orderBy", "procFtsRank:select", behavior];
          },
        },
      },
    },
    hooks: {
      init(_, build) {
        const {
          addConnectionFilterOperator,
          sql,
          graphql: { GraphQLString, Kind },
          dataplanPg: { TYPES, sqlValueWithCodec },
          inflection,
        } = build;

        if (!(addConnectionFilterOperator instanceof Function)) {
          throw new Error(
            "PgFulltextFilterPlugin requires PostGraphileConnectionFilterPlugin to be loaded before it.",
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

        const tsvectorCodec = TYPES.tsvector;
        build.setGraphQLTypeForPgCodec(
          tsvectorCodec,
          ["input", "output"],
          scalarName,
        );

        addConnectionFilterOperator(scalarName, "matches", {
          description: "Performs a full text search on the field.",
          resolveType: () => GraphQLString,
          resolve(sqlIdentifier, _sqlValue, input, pgCondition, { fieldName }) {
            const sqlValue = sqlValueWithCodec(input, TYPES.text);
            const qb = getQueryBuilder(build, pgCondition);

            const whereFragment = sql`${sqlIdentifier} @@ to_tsquery(${sqlValue})`;

            if (qb && qb.mode === "normal") {
              /* DO NOT DO THIS */
              const scoreFragment = sql`ts_rank(${sqlIdentifier}, to_tsquery(${sqlValue}))`;
              const selectIndex = qb.selectAndReturnIndex(scoreFragment);
              qb.setMeta(`__fts_ranks_${fieldName!}`, {
                selectIndex,
                scoreFragment,
              } as FtsRanksDetails);
            }

            return whereFragment;
          },
        });

        return _;
      },

      GraphQLObjectType_fields(fields, build, context) {
        const {
          dataplanPg: { TYPES },
          grafast: { lambda },
          graphql: { GraphQLFloat },
          input: { pgRegistry },
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
                      const $select = $row.getClassStep();
                      const $details = $select.getMeta(
                        `__fts_ranks_${baseFieldName}`,
                      ) as Step<Maybe<FtsRanksDetails>>;
                      return lambda([$details, $row], ([details, row]) => {
                        return details == null ||
                          row == null ||
                          row[details.selectIndex] == null
                          ? null
                          : TYPES.float.fromPg(
                              row[details.selectIndex] as string,
                            );
                      });
                    },
                  };
                },
              ),
            },
            origin,
          );
        }

        for (const [attributeName, attribute] of Object.entries(
          codec.attributes,
        )) {
          if (attribute.codec !== TYPES.tsvector) continue;
          if (
            !behavior.pgCodecAttributeMatches(
              [codec, attributeName],
              "attributeFtsRank:select",
            )
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
          (
            r: PgResource,
          ): r is PgResource<any, any, any, PgResourceParameter[], any> => {
            if (r.codec !== TYPES.tsvector) return false;
            if (!r.parameters) return false;
            if (!r.parameters[0]) return false;
            if (r.parameters[0].codec !== codec) return false;
            if (!behavior.pgResourceMatches(r, "typeField")) return false;
            if (!behavior.pgResourceMatches(r, "procFtsRank:select"))
              return false;
            if (typeof r.from !== "function") return false;

            // Must have only one required argument
            // if (r.parameters.slice(1).some((p) => !p.optional)) return false

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

        const makeApply =
          (fieldName: string, direction: "ASC" | "DESC") =>
          (queryBuilder: PgSelectQueryBuilder) => {
            const qb = getQueryBuilder(build, queryBuilder);
            const details = qb?.getMetaRaw(
              `__fts_ranks_${fieldName}`,
            ) as Maybe<FtsRanksDetails>;
            if (details) {
              const { scoreFragment: fragment } = details;
              queryBuilder.orderBy({
                codec: TYPES.float,
                fragment,
                direction,
              });
            }
          };

        const makeSpec = (fieldName: string, direction: "ASC" | "DESC") => ({
          extensions: {
            grafast: {
              apply: makeApply(fieldName, direction),
            },
          },
        });

        for (const [attributeName, attribute] of Object.entries(
          codec.attributes,
        )) {
          if (attribute.codec !== TYPES.tsvector) continue;
          if (
            !behavior.pgCodecAttributeMatches(
              [codec, attributeName],
              "attributeFtsRank:orderBy",
            )
          ) {
            continue;
          }

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

          build.extend(
            values,
            {
              [ascFieldName]: makeSpec(fieldName, "ASC"),
              [descFieldName]: makeSpec(fieldName, "DESC"),
            },
            `Adding orders for rank of ${attributeName} on ${context.Self.name}`,
          );
        }

        const tsvProcs = Object.values(pgRegistry.pgResources).filter(
          (
            r: PgResource,
          ): r is PgResource<any, any, any, PgResourceParameter[], any> => {
            if (r.codec !== TYPES.tsvector) return false;
            if (!r.parameters) return false;
            if (!r.parameters[0]) return false;
            if (r.parameters[0].codec !== codec) return false;
            if (!behavior.pgResourceMatches(r, "typeField")) return false;
            if (!behavior.pgResourceMatches(r, "procFtsRank:orderBy"))
              return false;
            if (typeof r.from !== "function") return false;

            // Must have only one required argument
            // if (r.parameters.slice(1).some((p) => !p.optional)) return false

            return true;
          },
        );

        for (const resource of tsvProcs) {
          const fieldName = inflection.computedAttributeField({
            resource,
          });
          const ascFieldName = inflection.pgTsvOrderByComputedColumnRankEnum(
            codec,
            resource,
            true,
          );
          const descFieldName = inflection.pgTsvOrderByComputedColumnRankEnum(
            codec,
            resource,
            false,
          );

          build.extend(
            values,
            {
              [ascFieldName]: makeSpec(fieldName, "ASC"),
              [descFieldName]: makeSpec(fieldName, "DESC"),
            },
            `Adding TSV rank columns for sorting on table '${codec.name}'`,
          );
        }
        return values;
      },
    },
  },
};

export const PgFulltextExposePlugin: GraphileConfig.Plugin = {
  name: "PgFulltextExposePlugin",
  schema: {
    entityBehavior: {
      pgCodecAttribute: {
        override: {
          before: ["PgBasicsPlugin"],
          callback(behavior, [codec, attributeName], build) {
            const attr = codec.attributes[attributeName];
            if (attr.codec !== build.dataplanPg.TYPES.tsvector) {
              return behavior;
            }
            // Restore the behaviors core disabled
            return [
              behavior,
              "attribute:base",
              "attribute:select",
              "attribute:insert",
              "attribute:update",
              "condition:attribute:filterBy",
              "attribute:orderBy",
            ];
          },
        },
      },
    },
  },
};

export default PgFulltextFilterPlugin;
