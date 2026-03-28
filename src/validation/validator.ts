import {
  GraphQLSchema,
  parse,
  validate,
  specifiedRules,
  NoUnusedFragmentsRule,
  KnownFragmentNamesRule,
  GraphQLError,
  DocumentNode,
} from "graphql"
import { GraphQLTemplateInfo } from "./queryFinder"
import { CacheManager } from "../cache/cacheManager"
import * as crypto from "crypto"

export interface ValidationError {
  message: string
  /** 0-based line in the source file */
  line: number
  /** 0-based column in the source file */
  column: number
  /** End line (0-based), if available */
  endLine?: number
  /** End column (0-based), if available */
  endColumn?: number
  /** The severity level */
  severity: "error" | "warning"
  /** Suggested fixes (field name suggestions) */
  suggestions?: string[]
}

export interface ValidationResult {
  template: GraphQLTemplateInfo
  errors: ValidationError[]
}

/**
 * Validate a single GraphQL template against the schema.
 * Uses an in-memory cache to skip re-validation of identical queries.
 */
export function validateTemplate(
  template: GraphQLTemplateInfo,
  schema: GraphQLSchema,
  cache?: CacheManager
): ValidationResult {
  const errors: ValidationError[] = []
  const queryHash = hashQuery(template.query)

  // Check memory cache
  if (cache?.hasMemory(queryHash)) {
    const cached = cache.getMemory<ValidationError[]>(queryHash)
    if (cached) {
      // Remap cached errors to current template position
      return {
        template,
        errors: remapErrors(cached, template),
      }
    }
  }

  // Step 1: Parse the GraphQL
  let document: DocumentNode
  try {
    document = parse(template.query)
  } catch (parseError) {
    if (parseError instanceof GraphQLError) {
      const loc = parseError.locations?.[0]
      errors.push({
        message: parseError.message,
        line: template.startLine + (loc ? loc.line - 1 : 0),
        column:
          (loc?.line === 1 ? template.startColumn : 0) +
          (loc ? loc.column - 1 : 0),
        severity: "error",
      })
    } else {
      errors.push({
        message: `GraphQL parse error: ${String(parseError)}`,
        line: template.startLine,
        column: template.startColumn,
        severity: "error",
      })
    }
    return { template, errors }
  }

  // Step 2: Validate against schema.
  // Exclude NoUnusedFragmentsRule: fragments may be defined in one file and
  // imported/spread in another (common with exported `gql` fragments), so
  // a "never used" error here is almost always a false positive.
  // Exclude KnownFragmentNamesRule: fragment definitions are frequently
  // imported from other files via `${FRAGMENT_DOC}` interpolation; we cannot
  // resolve cross-file imports statically, so unknown-fragment errors would
  // be false positives.  Field-level errors (wrong fields on the fragment
  // type) are still caught by other rules.
  const rules = specifiedRules.filter(
    r => r !== NoUnusedFragmentsRule && r !== KnownFragmentNamesRule
  )
  const validationErrors = validate(schema, document, rules)

  for (const error of validationErrors) {
    const loc = error.locations?.[0]
    const line = template.startLine + (loc ? loc.line - 1 : 0)
    const column =
      (loc?.line === 1 ? template.startColumn : 0) + (loc ? loc.column - 1 : 0)

    const suggestions = extractSuggestions(error.message)

    errors.push({
      message: error.message,
      line,
      column,
      severity: "error",
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    })
  }

  // Cache the base errors (before position remapping) for reuse
  if (cache) {
    const baseErrors = errors.map(e => ({
      ...e,
      line: e.line - template.startLine,
      column: e.column,
    }))
    cache.setMemory(queryHash, baseErrors)
  }

  return { template, errors }
}

/**
 * Validate all templates found in a file.
 */
export function validateTemplates(
  templates: GraphQLTemplateInfo[],
  schema: GraphQLSchema,
  cache?: CacheManager
): ValidationResult[] {
  return templates.map(t => validateTemplate(t, schema, cache))
}

/**
 * Extract field name suggestions from GraphQL error messages.
 * GraphQL error messages often contain "Did you mean X?" suggestions.
 */
function extractSuggestions(message: string): string[] {
  const suggestions: string[] = []
  // Pattern: Did you mean "field1", "field2", or "field3"?
  const didYouMean = message.match(/Did you mean (.+)\?/)
  if (didYouMean) {
    const namesStr = didYouMean[1]
    const names = namesStr.match(/"([^"]+)"/g)
    if (names) {
      for (const name of names) {
        suggestions.push(name.replace(/"/g, ""))
      }
    }
  }
  return suggestions
}

/**
 * Remap cached base errors to the current template's position.
 */
function remapErrors(
  baseErrors: ValidationError[],
  template: GraphQLTemplateInfo
): ValidationError[] {
  return baseErrors.map(e => ({
    ...e,
    line: e.line + template.startLine,
  }))
}

/**
 * Create a hash of a query string for cache keying.
 */
function hashQuery(query: string): string {
  return crypto.createHash("md5").update(query).digest("hex")
}
