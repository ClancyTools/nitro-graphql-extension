export interface GraphQLTemplateInfo {
  /** The raw GraphQL query text extracted from the template literal */
  query: string
  /** 0-based line number where the template literal starts in the source file */
  startLine: number
  /** 0-based column where the GraphQL text starts (after the backtick) */
  startColumn: number
  /** The full match text including gql` and ` */
  rawMatch: string
  /** Maps transformed query line numbers to the line where the interpolation occurs.
   * If a line in the transformed query came from an inlined interpolation,
   * we use this to remap errors to point to the ${...} location instead. */
  interpolationLineMap?: Map<number, number>
}

/**
 * Build a map of variable name → raw bare selection set content from the source text.
 * Scans for `const/let/var varName = ...` patterns where the template is a bare
 * selection set (either wrapped in `gql\`...\`` or plain `` `...` ``).
 * Bare selection sets can start with `{` or directly with field names.
 *
 * Examples:
 * - `const schema = gql\`{ id name }\`` → map.set("schema", content)
 * - `const fields = \`id name\`` → map.set("fields", content)
 */
export function buildInterpolationMap(sourceText: string): Map<string, string> {
  const map = new Map<string, string>()

  // Match both gql-tagged and untagged template assignments:
  // - const VARNAME = gql`...`
  // - const VARNAME = `...`
  const varPattern = /(?:const|let|var)\s+(\w+)\s*=\s*(?:gql\s*)?`/g
  let match: RegExpExecArray | null

  while ((match = varPattern.exec(sourceText)) !== null) {
    const varName = match[1]
    const templateStart = match.index + match[0].length

    const closeOffset = findClosingBacktick(sourceText, templateStart)
    if (closeOffset === -1) continue

    const content = sourceText.substring(templateStart, closeOffset)

    // Check if this looks like a bare selection set
    // Can be either:
    // - Starts with `{` for explicit selection sets, or
    // - Starts with a field name (identifier pattern) for implicit selection sets
    const withoutComments = content.replace(/#.*$/gm, "")
    const trimmed = withoutComments.trim()

    // Exclude GraphQL operation/fragment definitions by checking for keywords
    if (/^(query|mutation|subscription|fragment)\b/.test(trimmed)) {
      continue
    }

    // Include if it's a bare selection set:
    // - Starts with `{` (explicit), or
    // - Starts with a field name (implicit)
    if (trimmed.startsWith("{") || /^[a-zA-Z_]/.test(trimmed)) {
      map.set(varName, content)
    }
  }

  return map
}

/**
 * Find all gql`...` template literals in a source text.
 * Handles multiline queries, template literals with interpolations (${...}),
 * and various import styles (gql from graphql-tag, @apollo/client, etc.)
 */
export function findGraphQLTemplates(text: string): GraphQLTemplateInfo[] {
  const results: GraphQLTemplateInfo[] = []

  // Build a map of variable name → bare selection set content so that
  // `${varName}` interpolations can be resolved to their actual fields.
  const interpolationMap = buildInterpolationMap(text)

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

    // Replace ${...} interpolations, inlining resolved bare selection sets
    const replaceResult = replaceInterpolations(queryText, interpolationMap)

    // Calculate line/column of the GraphQL text start
    const { line, column } = offsetToPosition(text, startOffset)

    results.push({
      query: replaceResult.query,
      startLine: line,
      startColumn: column,
      rawMatch: text.substring(templateStart, closeOffset + 1),
      interpolationLineMap: replaceResult.lineMap,
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
 * Result of replacing interpolations, including position mapping.
 */
interface InterpolationReplaceResult {
  /** The transformed query text with interpolations replaced */
  query: string
  /** Maps transformed query line numbers to the line where the interpolation occurs.
   * E.g., if lines 3-5 in the transformed query came from an inlined interpolation
   * on line 1, then each of lines 3-5 maps to 1. */
  lineMap: Map<number, number>
}

/**
 * Replace ${...} interpolations so the surrounding GraphQL remains parseable.
 *
 * Behaviour depends on whether the variable can be resolved and the GraphQL brace depth:
 * - Selection-set level with a resolvable bare selection set variable: inline the actual
 *   selection set content so the interpolated fields are validated against the parent type.
 * - Inside a selection set (depth > 0), unresolvable: replace with `{ __typename }` so the
 *   field stays structurally valid without producing false-positive errors.
 * - At document level (depth = 0): the interpolation is almost always an
 *   imported fragment document.  Remove it entirely (preserve newlines) — the
 *   validator will still see any `...fragmentName` spread in the query, and
 *   we suppress KnownFragmentNamesRule separately to avoid false positives
 *   for cross-file fragments.
 *
 * Returns both the transformed query and a line mapping for error position remapping.
 */
function replaceInterpolations(
  queryText: string,
  interpolationMap: Map<string, string> = new Map()
): InterpolationReplaceResult {
  const out: string[] = []
  const lineMap = new Map<number, number>()
  let braceDepth = 0
  let i = 0
  let currentLine = 0

  while (i < queryText.length) {
    const ch = queryText[i]

    if (ch === "\n") {
      currentLine++
      out.push(ch)
      i++
    } else if (ch === "{") {
      braceDepth++
      out.push(ch)
      i++
    } else if (ch === "}") {
      braceDepth--
      out.push(ch)
      i++
    } else if (
      ch === "$" &&
      i + 1 < queryText.length &&
      queryText[i + 1] === "{"
    ) {
      // Find the matching closing } of the interpolation
      let j = i + 2
      let depth = 1
      while (j < queryText.length && depth > 0) {
        if (queryText[j] === "{") depth++
        else if (queryText[j] === "}") depth--
        j++
      }
      const match = queryText.slice(i, j)
      const interpolationLine = currentLine // Remember the line where this interpolation occurs

      // Extract the expression between ${ and } to check if it's a resolvable variable
      const exprContent = queryText.slice(i + 2, j - 1).trim()
      const isSimpleIdentifier = /^\w+$/.test(exprContent)

      if (braceDepth === 0) {
        // Document-level interpolation — remove content, preserve newlines only
        const newlines = (match.match(/\n/g) || []).length
        out.push("\n".repeat(newlines))
        currentLine += newlines
      } else if (isSimpleIdentifier && interpolationMap.has(exprContent)) {
        // Selection-set-level with a resolvable bare selection set variable —
        // inline the actual content so the fields are validated against the parent type
        const inlinedContent = interpolationMap.get(exprContent)!
        const inlinedLines = (inlinedContent.match(/\n/g) || []).length

        // Track that the inlined lines map back to the interpolation location
        for (let lineOffset = 0; lineOffset <= inlinedLines; lineOffset++) {
          lineMap.set(currentLine + 1 + lineOffset, interpolationLine)
        }

        out.push(inlinedContent)
        currentLine += inlinedLines
      } else {
        // Selection-set-level with unresolvable expression.
        // Determine context by examining what comes before the interpolation.
        // If interpolation comes right after `)` (field arguments), it's on a field → use { __typename }
        // If interpolation is inside selection set body, use __typename
        const newlines = (match.match(/\n/g) || []).length

        // Look back to see if we're on a field with arguments
        let before = i - 1
        while (before >= 0 && /\s/.test(queryText[before])) {
          before--
        }
        const prevChar = before >= 0 ? queryText[before] : ""
        const isOnFieldWithArgs = prevChar === ")"

        const replacement = isOnFieldWithArgs
          ? "{ __typename }" + "\n".repeat(newlines)
          : "__typename" + "\n".repeat(newlines)

        const replacementLines = (replacement.match(/\n/g) || []).length

        // Track that replacement lines map back to the interpolation location
        for (let lineOffset = 0; lineOffset <= replacementLines; lineOffset++) {
          lineMap.set(currentLine + 1 + lineOffset, interpolationLine)
        }

        out.push(replacement)
        currentLine += replacementLines
      }
      i = j
    } else {
      out.push(ch)
      i++
    }
  }

  return {
    query: out.join(""),
    lineMap,
  }
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
