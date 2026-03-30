import {
  GraphQLSchema,
  parse,
  validate,
  specifiedRules,
  NoUnusedFragmentsRule,
  KnownFragmentNamesRule,
  NoUnusedVariablesRule,
  GraphQLError,
  DocumentNode,
} from "graphql"
import { GraphQLTemplateInfo } from "./queryFinder"
import { CacheManager } from "../cache/cacheManager"
import { enhanceValidationErrorMessage } from "../schema/rubySchemaBuilder"
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

/**
 * Remap error line numbers based on interpolation line mapping.
 * If an error occurs on a line that was part of an inlined interpolation,
 * remap it to point to the line where the ${...} occurred instead.
 */
function remapErrorByInterpolation(
  error: ValidationError,
  template: GraphQLTemplateInfo
): ValidationError {
  if (
    !template.interpolationLineMap ||
    template.interpolationLineMap.size === 0
  ) {
    return error
  }

  // Check if this error's line is in the interpolation map
  const lineInQuery = error.line - template.startLine
  if (template.interpolationLineMap.has(lineInQuery)) {
    const interpolationLineInQuery =
      template.interpolationLineMap.get(lineInQuery)!
    return {
      ...error,
      line: template.startLine + interpolationLineInQuery,
    }
  }

  return error
}

/**
 * Check if a query template has any substantial GraphQL content.
 * The queryFinder already replaces ${...} with newlines to preserve positions.
 * If nothing but whitespace/comments remain, return true to skip validation.
 */
function isInterpolatedQuery(queryText: string): boolean {
  // Remove GraphQL comments
  let processedText = queryText.replace(/#.*$/gm, " ")

  // Remove whitespace and check if anything meaningful remains
  const trimmed = processedText.replace(/\s+/g, " ").trim()

  // If nothing substantial remains after removing comments/whitespace, it's interpolated-only
  // Also return true if it's only fragment spreads like "...fragmentName"
  return trimmed.length === 0 || /^(\.{3}\s*\w+\s*)*$/.test(trimmed)
}

/**
 * Check if this is a bare selection set (fragment) rather than a complete query.
 * Examples: `{ id name }` or `{ ... on Type { field } }`
 * These are typically used as reusable fragments/selectors and shouldn't be
 * validated as standalone queries.
 * Distinguishes from explicit operations: `query { ... }`, `mutation { ... }`, etc.
 */
function isBareSelectionSet(
  document: DocumentNode,
  originalQueryText: string
): boolean {
  // Check if document has exactly one definition and it's an unnamed query operation
  if (document.definitions.length !== 1) {
    return false
  }

  const def = document.definitions[0]

  // Check if it's an OperationDefinition (not a FragmentDefinition)
  if (def.kind !== "OperationDefinition") {
    return false
  }

  // Check if the original text starts with an operation keyword (query/mutation/subscription)
  // If it does, it's an explicit operation, not a bare selection set
  const trimmed = originalQueryText.trim()
  if (/^(query|mutation|subscription|fragment)\b/.test(trimmed)) {
    return false
  }

  // It's a bare selection set if:
  // - It has no operation name (unnamed query or bare {})
  // - The operation type is "query" (default)
  // - It has no variable definitions
  return def.name === undefined && def.variableDefinitions?.length === 0
}

export interface ValidationResult {
  template: GraphQLTemplateInfo
  errors: ValidationError[]
}

/**
 * Validate a single GraphQL template against the schema.
 * Uses an in-memory cache to skip re-validation of identical queries.
 * Skips validation for queries that are entirely interpolated imports.
 */
export function validateTemplate(
  template: GraphQLTemplateInfo,
  schema: GraphQLSchema,
  cache?: CacheManager
): ValidationResult {
  const errors: ValidationError[] = []

  // Skip validation for queries that are entirely interpolated
  // (e.g., const QUERY = gql`${PROJECT_TASK}` or gql`${FRAGMENT}`)
  if (isInterpolatedQuery(template.query)) {
    return {
      template,
      errors: [],
    }
  }

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
      let parseErr: ValidationError = {
        message: parseError.message,
        line: template.startLine + (loc ? loc.line - 1 : 0),
        column:
          (loc?.line === 1 ? template.startColumn : 0) +
          (loc ? loc.column - 1 : 0),
        severity: "error",
      }
      // Remap parse error line if it falls within an inlined interpolation
      parseErr = remapErrorByInterpolation(parseErr, template)
      errors.push(parseErr)
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

  // Skip validation for bare selection sets (e.g., `{ id name }` or reusable fragments)
  // These are typically used as imports/spreads in other queries, not standalone queries
  if (isBareSelectionSet(document, template.query)) {
    return {
      template,
      errors: [],
    }
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
  // Exclude NoUnusedVariablesRule when interpolations are present: variables
  // declared in the query operation may be used only in interpolated fragments
  // (e.g., fragments imported from other files), which we cannot statically resolve.
  // Check rawMatch for ${...} to detect interpolations, since document-level
  // interpolations don't populate the lineMap.
  const hasInterpolations =
    template.rawMatch.includes("${") ||
    (template.interpolationLineMap && template.interpolationLineMap.size > 0)
  const rules = specifiedRules.filter(r => {
    if (r === NoUnusedFragmentsRule || r === KnownFragmentNamesRule) {
      return false
    }
    if (hasInterpolations && r === NoUnusedVariablesRule) {
      return false
    }
    return true
  })
  const validationErrors = validate(schema, document, rules)

  for (const error of validationErrors) {
    const loc = error.locations?.[0]
    const line = template.startLine + (loc ? loc.line - 1 : 0)
    const column =
      (loc?.line === 1 ? template.startColumn : 0) + (loc ? loc.column - 1 : 0)

    const suggestions = extractSuggestions(error.message)

    let validationError: ValidationError = {
      message: enhanceValidationErrorMessage(error.message),
      line,
      column,
      severity: "error",
      suggestions: suggestions.length > 0 ? suggestions : undefined,
    }

    // Remap error line if it falls within an inlined interpolation
    validationError = remapErrorByInterpolation(validationError, template)

    errors.push(validationError)
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
  return baseErrors.map(e => {
    // First remap to template position
    const remappedToTemplate: ValidationError = {
      ...e,
      line: e.line + template.startLine,
    }
    // Then apply interpolation line mapping if needed
    return remapErrorByInterpolation(remappedToTemplate, template)
  })
}

/**
 * Create a hash of a query string for cache keying.
 */
function hashQuery(query: string): string {
  return crypto.createHash("md5").update(query).digest("hex")
}
