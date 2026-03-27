export interface GraphQLTemplateInfo {
  /** The raw GraphQL query text extracted from the template literal */
  query: string
  /** 0-based line number where the template literal starts in the source file */
  startLine: number
  /** 0-based column where the GraphQL text starts (after the backtick) */
  startColumn: number
  /** The full match text including gql` and ` */
  rawMatch: string
}

/**
 * Find all gql`...` template literals in a source text.
 * Handles multiline queries, template literals with interpolations (${...}),
 * and various import styles (gql from graphql-tag, @apollo/client, etc.)
 */
export function findGraphQLTemplates(text: string): GraphQLTemplateInfo[] {
  const results: GraphQLTemplateInfo[] = []
  const lines = text.split("\n")

  // Match gql` or gql(` patterns — we track backtick-delimited templates
  // This regex finds the start of gql template literals
  const gqlStartPattern = /\bgql\s*`/g

  let match: RegExpExecArray | null
  while ((match = gqlStartPattern.exec(text)) !== null) {
    const startOffset = match.index + match[0].length // offset right after the opening backtick
    const templateStart = match.index // offset of `gql`

    // Find the closing backtick, handling ${...} interpolations
    const closeOffset = findClosingBacktick(text, startOffset)
    if (closeOffset === -1) {
      continue // Unclosed template literal
    }

    // Extract the GraphQL text (between the backticks)
    let queryText = text.substring(startOffset, closeOffset)

    // Replace ${...} interpolations with placeholder comments to preserve line positions
    queryText = replaceInterpolations(queryText)

    // Calculate line/column of the GraphQL text start
    const { line, column } = offsetToPosition(text, startOffset)

    results.push({
      query: queryText,
      startLine: line,
      startColumn: column,
      rawMatch: text.substring(templateStart, closeOffset + 1),
    })
  }

  return results
}

/**
 * Find the closing backtick for a template literal, properly handling
 * nested ${...} expressions (which may contain backticks themselves).
 */
function findClosingBacktick(text: string, startOffset: number): number {
  let i = startOffset
  while (i < text.length) {
    const ch = text[i]

    if (ch === "`") {
      return i
    }

    if (ch === "\\") {
      i += 2 // skip escaped character
      continue
    }

    if (ch === "$" && i + 1 < text.length && text[i + 1] === "{") {
      // Skip the interpolation: find matching }
      i = skipInterpolation(text, i + 2)
      continue
    }

    i++
  }
  return -1 // no closing backtick found
}

/**
 * Skip a ${...} interpolation, properly handling nested braces, strings, and template literals.
 */
function skipInterpolation(text: string, startOffset: number): number {
  let depth = 1
  let i = startOffset

  while (i < text.length && depth > 0) {
    const ch = text[i]

    if (ch === "{") {
      depth++
    } else if (ch === "}") {
      depth--
      if (depth === 0) {
        return i + 1
      }
    } else if (ch === "`") {
      // Nested template literal — skip it
      i++
      while (i < text.length) {
        if (text[i] === "`") {
          break
        }
        if (text[i] === "\\") {
          i++
        }
        if (text[i] === "$" && i + 1 < text.length && text[i + 1] === "{") {
          i = skipInterpolation(text, i + 2)
          continue
        }
        i++
      }
    } else if (ch === "'" || ch === '"') {
      // Skip string literals
      i++
      while (i < text.length && text[i] !== ch) {
        if (text[i] === "\\") {
          i++
        }
        i++
      }
    }

    i++
  }

  return i
}

/**
 * Replace ${...} interpolations with blank lines of the same length
 * to preserve line numbering for GraphQL error reporting.
 */
function replaceInterpolations(queryText: string): string {
  // Replace ${...} with equivalent whitespace to preserve positions
  return queryText.replace(/\$\{[^}]*\}/g, match => {
    // Replace with spaces of the same length to preserve column offsets
    // But if it contains newlines, preserve those
    return match.replace(/[^\n]/g, " ")
  })
}

/**
 * Convert a character offset to a 0-based line/column position.
 */
function offsetToPosition(
  text: string,
  offset: number
): { line: number; column: number } {
  let line = 0
  let column = 0
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++
      column = 0
    } else {
      column++
    }
  }
  return { line, column }
}
