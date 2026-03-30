import * as fs from "fs"
import * as path from "path"
import * as logger from "../outputChannel"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInterfaceType,
  GraphQLUnionType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLScalarType,
  GraphQLOutputType,
  GraphQLInputType,
  GraphQLFieldConfigMap,
  GraphQLFieldConfigArgumentMap,
  GraphQLInputFieldConfigMap,
  GraphQLEnumValueConfigMap,
  validateSchema,
} from "graphql"

// ── Types ──────────────────────────────────────────────────────────────────────

export type AccessLevel = string[]

export interface FieldDefinition {
  name: string
  type: string
  nullable: boolean
  isList: boolean
  /** Nesting depth for lists; e.g. [[Type]] has listDepth=2, [Type] has listDepth=1, Type has listDepth=0 */
  listDepth: number
  access: AccessLevel
  /** Arguments declared inline on this field inside a `do...end` block */
  fieldArgs?: ArgumentDefinition[]
  /** Field description for context */
  description?: string
  /** Full Ruby path of the field type, e.g. "Directory::Graphql::EquipmentAssetType".
   * Preserved so the schema builder can use rubyPathMap to disambiguate when two
   * namespaces define a type with the same classBasedName. */
  typeRubyPath?: string
  /** When a field uses `field :name, resolver: Class`, the resolver class name.
   * The schema builder wires up the return type and arguments from that resolver. */
  resolverClassName?: string
  /** When true (or omitted), field name is camelCased. When false, kept as-is.
   * E.g. `field :new_appts_plan, String, camelize: false` → "new_appts_plan" instead of "newApptsPlan" */
  camelize?: boolean
  /** When true, this field uses .connection_type for Relay pagination (e.g., MyType.connection_type).
   * Indicates the field should be wrapped in a connection type with first/last/before/after args. */
  isConnectionType?: boolean
}

export interface ArgumentDefinition {
  name: string
  type: string
  /** Full Ruby path of the argument type, e.g. "BrandHeadlines::Graphql::CalendarEventInput".
   * Preserved when the argument declares a namespaced type, for unambiguous resolution. */
  typeRubyPath?: string
  required: boolean
  isList: boolean
  /** Nesting depth for lists; e.g. [[String]] has listDepth=2, [String] has listDepth=1, String has listDepth=0 */
  listDepth: number
  defaultValue?: string
}

export interface ResolverDefinition {
  className: string
  /** Full Ruby parent class name (leading :: stripped), e.g. "EmployeeReviews::Graphql::UpdateReviewMutationBase".
   * Used by resolveResolverInheritance to walk the parent chain and merge arguments. */
  parentClass: string
  returnType: string
  /** Full Ruby path of the return type, e.g. "BrandHeadlines::Graphql::CalendarEventType".
   * Preserved when the resolver declares a namespaced type, for unambiguous resolution. */
  returnTypeRubyPath?: string
  returnTypeIsList: boolean
  /** Nesting depth for lists; e.g. [[Type]] has returnTypeListDepth=2, [Type] has returnTypeListDepth=1 */
  returnTypeListDepth: number
  /** True only when the resolver uses `Type.connection_type` syntax — triggers Relay Connection wrapping */
  isConnectionType: boolean
  returnTypeNullable: boolean
  arguments: ArgumentDefinition[]
  fileName: string
  /** Query/Mutation description */
  description?: string
}

export interface ResolverRegistration {
  fieldName: string
  resolverClassName: string
  target: "query" | "mutation"
  /** Access level parsed from the registration field declaration (e.g. ["private"]) */
  access?: AccessLevel
  /** Component namespace where this resolver was registered (e.g. "TerritoryMaps").
   * Used to prefer same-namespace resolvers when resolver class name is unqualified. */
  componentNamespace?: string
}

/**
 * A single field pattern inside a dynamic `.each` block.
 * e.g. for `field :"#{column}_average", Float` → { suffix: "_average", type: "Float" }
 * or   `field column, Integer`                  → { suffix: "",          type: "Int"   }
 */
export interface DynamicFieldPattern {
  /** Suffix appended to each field name; empty for bare variable use */
  suffix: string
  /** Resolved GraphQL type name (e.g. "Int", "Float", "String") */
  type: string
}

/**
 * Describes a dynamic `.each` block found in a Type definition like:
 *   SomeClass.method_name.each do |col|
 *     field col, Integer
 *     field :"#{col}_average", Float
 *   end
 * Or inline:
 *   %i[field1 field2].each do |col|
 *     field col, Integer
 *   end
 *
 * For cross-file resolution (ClassName.method), className/methodName are set.
 * For inline arrays (%i[...]), inlineValues are set instead.
 */
export interface DynamicFieldBlock {
  /** Class on which the method is called (when not inline) */
  className?: string
  /** Method name (when not inline), e.g. "counter_columns" */
  methodName?: string
  /** True when `.keys.each` is used — means the method returns a hash and we want its keys */
  useKeys: boolean
  /** The block variable name, e.g. "column" */
  blockVar: string
  /** All field patterns found inside the block */
  patterns: DynamicFieldPattern[]
  /** For inline arrays like %i[...], the field names are directly available */
  inlineValues?: string[]
}

export interface GraphQLTypeDefinition {
  name: string
  /** The name derived from the Ruby class name (before graphql_name override) */
  classBasedName: string
  kind: "object" | "input" | "interface" | "enum" | "scalar" | "union"
  parentClass: string
  fields: FieldDefinition[]
  implements: string[]
  enumValues: string[]
  /** Populated for union types — the list of member type names (short names only) */
  possibleTypes?: string[]
  /** Populated for union types — full Ruby paths for each possible type (e.g., "Module::Namespace::TypeName").
   * Enables disambiguation when multiple types share the same short name in different namespaces. */
  possibleTypesRubyPaths?: string[]
  fileName: string
  /** Type description */
  description?: string
  /** Full Ruby class path including modules, e.g. "BrandHeadlines::Graphql::CalendarEventType".
   * Used to disambiguate types with the same classBasedName in different namespaces. */
  rubyPath?: string
  /** Dynamic fields sourced from `.each` blocks — resolved separately at schema-build time */
  dynamicFieldBlocks?: DynamicFieldBlock[]
}

// ── File Discovery ─────────────────────────────────────────────────────────────

/**
 * Recursively find all directories named "graphql" under basePath.
 * Follows the CoBRA pattern: components/* /app/graphql/* /graphql/
 */
export function findGraphQLDirectories(basePath: string): string[] {
  const results: string[] = []

  function walk(dir: string, depth: number = 0): void {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }

      // Skip common non-relevant directories
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "tmp" ||
        entry.name === "log" ||
        entry.name === "vendor"
      ) {
        continue
      }

      const fullPath = path.join(dir, entry.name)

      if (entry.name === "graphql") {
        results.push(fullPath)
      }

      // Also include `types` directories under `lib/` paths.
      // These hold shared framework types (e.g. nitro_graphql/lib/nitro_graphql/types/)
      // that are referenced across the codebase but live outside app/graphql/.
      if (entry.name === "types" && dir.includes("/lib/")) {
        results.push(fullPath)
      }

      // Limit recursion depth to avoid scanning huge trees
      if (depth < 10) {
        walk(fullPath, depth + 1)
      }
    }
  }

  walk(basePath)
  logger.log(
    `[NitroGraphQL] graphql directories found: ${results.map(d => d.replace(basePath + "/", "")).join(", ") || "(none)"}`
  )
  return results
}

/**
 * Load all .rb files from the given directories.
 * Returns a map of file path → file contents.
 */
export function loadGraphQLTypeFiles(
  directories: string[]
): Map<string, string> {
  const files = new Map<string, string>()

  for (const dir of directories) {
    loadRbFilesRecursive(dir, files)
  }

  return files
}

function loadRbFilesRecursive(dir: string, files: Map<string, string>): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      loadRbFilesRecursive(fullPath, files)
    } else if (entry.isFile() && entry.name.endsWith(".rb")) {
      try {
        const content = fs.readFileSync(fullPath, "utf-8")
        files.set(fullPath, content)
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        logger.warn(
          `[NitroGraphQL] ⚠️  Failed to read file: ${fullPath}\\n` +
            `    Reason: ${errorMsg}\\n` +
            `    💡 Check file permissions and that the file exists`
        )
      }
    }
  }
}

/**
 * Load Ruby files from lib/ directories that look like argument-providing mixins.
 * These live outside the normal graphql/ scan path — e.g.
 *   components/nitro_graphql/lib/nitro_graphql/pagination_arguments.rb
 * Only files that actually contain both `self.included` and `argument` are loaded,
 * so this scan is cheap even for large codebases.
 */
export function loadMixinFiles(basePath: string): Map<string, string> {
  const files = new Map<string, string>()

  function walk(dir: string, insideLibDir: boolean, depth: number): void {
    if (depth > 12) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    // We're "inside a lib dir" once we've descended into a directory named `lib`
    const nowInsideLib = insideLibDir || path.basename(dir) === "lib"

    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "tmp" ||
        entry.name === "vendor" ||
        entry.name === "spec" ||
        entry.name === "test"
      ) {
        continue
      }

      const fullPath = path.join(dir, entry.name)

      if (entry.isDirectory()) {
        walk(fullPath, nowInsideLib, depth + 1)
      } else if (entry.isFile() && entry.name.endsWith(".rb") && nowInsideLib) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8")
          // Only keep files that are actually argument-providing mixins
          if (
            content.includes("self.included") &&
            content.includes("argument ")
          ) {
            files.set(fullPath, content)
          }
        } catch {
          // ignore unreadable files
        }
      }
    }
  }

  walk(basePath, false, 0)
  return files
}

// ── Ruby Parsing ───────────────────────────────────────────────────────────────

/**
 * Detect if a file is likely JavaScript/TypeScript based on common markers.
 * Used to skip non-Ruby files that might be in graphql directories.
 */
function isJavaScriptFile(content: string): boolean {
  const lines = content.split("\n").slice(0, 20) // Check first 20 lines
  const jsMarkers = [
    /^\s*import\s+.*from\s+["'`]/,
    /^\s*export\s+(const|function|class|interface|type)/,
    /^\s*(const|let|var)\s+\w+\s*[:=]/,
    /^\s*function\s+\w+\s*\(/,
  ]

  let jsLineCount = 0
  for (const line of lines) {
    for (const marker of jsMarkers) {
      if (marker.test(line)) {
        jsLineCount++
        break
      }
    }
  }

  // If we find 2+ JS markers, it's probably not a Ruby file
  return jsLineCount >= 2
}

/**
 * Parse a Ruby GraphQL type definition file into a structured definition.
 * Returns null for resolver classes (use parseResolverDefinition instead).
 */
export function parseRubyTypeDefinition(
  fileContent: string,
  fileName: string
): GraphQLTypeDefinition | null {
  // Skip non-Ruby files (e.g., TypeScript/JavaScript)
  if (isJavaScriptFile(fileContent)) {
    return null
  }

  // Remove Ruby comments (lines starting with #)
  const lines = fileContent.split("\n")
  const contentLines = lines.filter(l => !l.trim().startsWith("#"))
  const content = contentLines.join("\n")

  // --- Path 1: class-based definition (class Foo < Bar) ---
  // Extract all class definitions and find the first valid type (skip resolvers)
  const classRegex = /class\s+(\w+)\s*<\s*([\w:]+)/g
  let classMatch: RegExpExecArray | null
  let typeClassName: string = ""
  let typeParentClass: string = ""
  let typeKind: GraphQLTypeDefinition["kind"] | null = null
  let foundTypeClass = false

  while ((classMatch = classRegex.exec(content)) !== null) {
    const className = classMatch[1]
    const parentClass = classMatch[2]

    // Check if this is a resolver class — skip it
    if (isResolverClass(parentClass, className)) {
      continue
    }

    // Determine kind from parent class
    const kind = inferKind(parentClass)
    if (!kind) {
      continue
    }

    typeClassName = className
    typeParentClass = parentClass
    typeKind = kind
    foundTypeClass = true
    break
  }

  if (foundTypeClass) {
    const className = typeClassName
    const parentClass = typeParentClass
    const kind = typeKind!

    // Extract graphql_name if present, otherwise derive from class name
    const graphqlNameMatch = content.match(/graphql_name\s+["'](\w+)["']/)
    const classBasedName = deriveTypeName(className)
    const name = graphqlNameMatch ? graphqlNameMatch[1] : classBasedName

    // Union types: parse possible_types members, no fields
    if (kind === "union") {
      const description = extractDescription(content)
      // Build full Ruby path for namespace-aware disambiguation (same as other types)
      const rubyModules: string[] = []
      const rubyModuleRegex = /module\s+(\w+)/g
      let rubyModMatch: RegExpExecArray | null
      while ((rubyModMatch = rubyModuleRegex.exec(content)) !== null) {
        rubyModules.push(rubyModMatch[1])
      }
      const rubyPath = [...rubyModules, className].join("::")
      const modulePath = rubyModules.join("::")

      // Parse possible types with both short and full paths in one call
      const possibleTypeEntries = parsePossibleTypes(content, modulePath)
      const possibleTypes = possibleTypeEntries.map(t => t.short)
      const possibleTypesRubyPaths = possibleTypeEntries.map(t => t.full)

      return {
        name,
        classBasedName,
        kind: "union",
        parentClass,
        fields: [],
        implements: [],
        enumValues: [],
        possibleTypes,
        possibleTypesRubyPaths,
        fileName,
        description,
        rubyPath,
      }
    }

    // Extract implements
    const implementsList: string[] = []
    const implementsRegex = /implements\s+:*([:\w]+)/g
    let implMatch: RegExpExecArray | null
    while ((implMatch = implementsRegex.exec(content)) !== null) {
      const raw = implMatch[1]
      const parts = raw.split("::")
      const implClass = parts[parts.length - 1]
      implementsList.push(deriveTypeName(implClass))
    }

    // Extract enum values
    const enumValues: string[] = []
    if (kind === "enum") {
      const valueRegex = /value\s+["'](\w+)["']/g
      let valueMatch: RegExpExecArray | null
      while ((valueMatch = valueRegex.exec(content)) !== null) {
        enumValues.push(valueMatch[1])
      }
    }

    const fields = parseFields(content, kind)
    const description = extractDescription(content)
    const dynamicFieldBlocks = detectDynamicFieldBlocks(content)

    // Build full Ruby path for namespace-aware disambiguation.
    // Extract module declarations in order of appearance.
    const rubyModules: string[] = []
    const rubyModuleRegex = /module\s+(\w+)/g
    let rubyModMatch: RegExpExecArray | null
    while ((rubyModMatch = rubyModuleRegex.exec(content)) !== null) {
      rubyModules.push(rubyModMatch[1])
    }
    const rubyPath = [...rubyModules, className].join("::")

    return {
      name,
      classBasedName,
      kind,
      parentClass,
      fields,
      implements: implementsList,
      enumValues,
      fileName,
      description,
      rubyPath,
      dynamicFieldBlocks:
        dynamicFieldBlocks.length > 0 ? dynamicFieldBlocks : undefined,
    }
  }

  // --- Path 2: module-based interface (module Foo; include BaseInterface) ---
  // Ruby GraphQL interfaces are defined as modules that include a BaseInterface.
  // The file may have nested namespace modules — find the innermost module whose
  // body contains the `include BaseInterface` line.
  const includeInterfaceMatch = content.match(
    /include\s+([\w:]*(?:BaseInterface|Interface))/
  )

  if (includeInterfaceMatch) {
    // Walk backwards from the include line to find the closest `module Foo` declaration
    const includeIndex = content.indexOf(includeInterfaceMatch[0])
    const beforeInclude = content.slice(0, includeIndex)
    const moduleMatches = [...beforeInclude.matchAll(/module\s+(\w+)/g)]

    if (moduleMatches.length > 0) {
      // The last (innermost) module before the include is the interface module
      const interfaceModuleMatch = moduleMatches[moduleMatches.length - 1]
      const moduleName = interfaceModuleMatch[1]

      // Skip namespace-only modules (e.g. module Graphql, module Warranty)
      // The interface module name typically ends in "Interface"
      if (moduleName.endsWith("Interface")) {
        const graphqlNameMatch = content.match(/graphql_name\s+["'](\w+)["']/)
        const classBasedName = deriveTypeName(moduleName)
        const name = graphqlNameMatch ? graphqlNameMatch[1] : classBasedName
        const description = extractDescription(content)

        const fields = parseFields(content, "interface")

        return {
          name,
          classBasedName,
          kind: "interface",
          parentClass: "",
          fields,
          implements: [],
          enumValues: [],
          fileName,
          description,
        }
      }
    }
  }

  return null
}

/**
 * Check if the parent class indicates a resolver (BaseQuery / Resolver / TicketQuery).
 * Also checks the class name itself as a fallback for intermediate base classes.
 */
function isResolverClass(
  parentClass: string,
  childClassName?: string
): boolean {
  const lower = parentClass.toLowerCase()
  const parentMatches =
    lower.includes("basequery") ||
    lower.includes("base_query") ||
    lower.includes("resolver") ||
    lower.includes("basemutation") ||
    lower.includes("base_mutation") ||
    // Catch intermediate mutation base classes such as UpdateReviewMutationBase
    // where "mutation" appears in the name but not as the "BaseMutation" prefix.
    lower.includes("mutation") ||
    // Catch intermediate query base classes like Support::Graphql::TicketQuery
    // when "query" appears anywhere in the parent class name
    lower.includes("query")

  // If parent class doesn't match but we have a child class name, check if
  // the child ends with Query or Mutation (strong indicator of resolver)
  if (!parentMatches && childClassName) {
    const childLower = childClassName.toLowerCase()
    return childLower.endsWith("query") || childLower.endsWith("mutation")
  }

  return parentMatches
}

/**
 * Infer the GraphQL kind from the Ruby parent class name.
 */
function inferKind(parentClass: string): GraphQLTypeDefinition["kind"] | null {
  const lower = parentClass.toLowerCase()
  if (lower.includes("inputobject") || lower.includes("input_object")) {
    return "input"
  }
  if (lower.includes("interface")) {
    return "interface"
  }
  if (lower.includes("enum")) {
    return "enum"
  }
  if (lower.includes("scalar")) {
    return "scalar"
  }
  if (lower.includes("baseunion") || lower.includes("base_union")) {
    return "union"
  }
  if (lower.includes("baseobject") || lower.includes("object")) {
    return "object"
  }
  // Custom type inheritance: class FooType < OtherModule::BarType
  // Check InputType before Type so XxxInputType is classified as input, not object.
  const parts = parentClass.split("::")
  const lastPart = parts[parts.length - 1]
  if (lastPart.endsWith("InputType")) {
    return "input"
  }
  if (lastPart.endsWith("Union")) {
    return "union"
  }
  if (lastPart.endsWith("Type")) {
    return "object"
  }
  return null
}

/**
 * Parse the possible_types list from a Ruby union class body.
 * Handles both single-line: `possible_types TypeA, TypeB`
 * and multi-line: `possible_types(\n  TypeA,\n  TypeB\n)` or without parens
 */
function parsePossibleTypes(
  content: string,
  currentModulePath?: string
): { short: string; full: string }[] {
  // With parens (possibly multiline): possible_types(TypeA, TypeB)
  const parenMatch = content.match(/\bpossible_types\s*\(([\s\S]*?)\)/)
  if (parenMatch) {
    return extractRubyTypeNames(parenMatch[1], currentModulePath)
  }

  // Without parens: possible_types TypeA, TypeB (may span multiple lines if lines end with comma)
  // Match from possible_types keyword to indented lines that continue the list until we hit class/def
  const inlineMatch = content.match(
    /\bpossible_types\s+([\s\S]*?)(?=\n\s*(?:def|class|module|field|#|end|\Z))/
  )
  if (inlineMatch) {
    return extractRubyTypeNames(inlineMatch[1], currentModulePath)
  }
  return []
}

/**
 * Extract Ruby type names from possible_types declaration.
 * Returns array of { short: "TypeName", full: "Module::Namespace::TypeName" } objects.
 * If fully qualified paths are present (with ::), uses them.
 * Otherwise, assumes they're in the current module/namespace.
 */
function extractRubyTypeNames(
  raw: string,
  currentModulePath?: string
): { short: string; full: string }[] {
  return raw
    .split(",")
    .map(t => {
      const trimmed = t.replace(/[()]/g, "").trim()
      if (!trimmed) return null

      const parts = trimmed
        .split("::")
        .map(p => p.trim())
        .filter(Boolean)
      const last = parts[parts.length - 1]
      const shortName = deriveTypeName(last)

      // If fully qualified (starts with :: or has multiple parts), use as-is
      // Otherwise, prepend current module path
      const fullPath =
        trimmed.startsWith("::") || parts.length > 1
          ? parts.join("::") // Use the qualified path
          : currentModulePath
            ? `${currentModulePath}::${last}`
            : last // Fallback to just the class name

      return { short: shortName, full: fullPath }
    })
    .filter((x): x is { short: string; full: string } => x !== null)
}

/**
 * Derive a GraphQL type name from a Ruby class name.
 * e.g. "CourseType" → "Course", "EmployeeInputType" → "EmployeeInput"
 */
function deriveTypeName(className: string): string {
  // Strip "Type" suffix — Ruby convention uses `FooType` → GraphQL `Foo`
  if (className.endsWith("Type")) {
    return className.slice(0, -4)
  }
  return className
}

/**
 * Extract the inner lines of a `do...end` block starting at startLineIndex.
 * Handles nested do...end blocks by counting depth.
 * Does NOT include the first line (the `.each do |var|` header) nor the final `end`.
 */
function extractDoBlockInnerLines(
  lines: string[],
  startLineIndex: number
): string[] {
  let depth = 0
  const inner: string[] = []

  for (let i = startLineIndex; i < lines.length; i++) {
    // Strip comments and string literals to avoid false `do`/`end` matches
    const stripped = lines[i]
      .replace(/#.*$/, "")
      .replace(/"[^"]*"|'[^']*'|:[^:,\s\]{}()]+/, "")
    const doCount = (stripped.match(/\bdo\b/g) || []).length
    const endCount = (stripped.match(/\bend\b/g) || []).length

    depth += doCount - endCount

    if (i === startLineIndex) {
      // The header line contributes 1 `do`, depth should be 1 after. Skip adding to inner.
      continue
    }

    if (depth <= 0) {
      // This is the closing `end` for the block — stop
      break
    }
    inner.push(lines[i])
  }

  return inner
}

/**
 * Given the inner lines of an `.each do |blockVar|` block, extract all
 * field declaration patterns that reference the block variable.
 *
 * Handles:
 *   field column, Integer              → { suffix: "", type: "Int" }
 *   field column.to_sym, Integer       → { suffix: "", type: "Int" }
 *   field :"#{column}_average", Float  → { suffix: "_average", type: "Float" }
 */
function extractFieldPatternsFromBlock(
  blockLines: string[],
  blockVar: string
): DynamicFieldPattern[] {
  const patterns: DynamicFieldPattern[] = []
  const seen = new Set<string>()

  for (const line of blockLines) {
    // Skip lines inside nested define_method/do blocks that don't contain `field`
    if (!line.includes("field")) continue

    // Pattern 1: field blockVar[.method_call], Type  (bare variable with optional method calls like .to_sym)
    const bareRe = new RegExp(
      `\\bfield\\s+${blockVar}(?:\\.[\\w]+)*\\s*,\\s*([A-Z]\\w*)`
    )
    const bareM = line.match(bareRe)
    if (bareM) {
      const type = normalizeRubyType(bareM[1])
      if (type) {
        const key = `|${type}`
        if (!seen.has(key)) {
          seen.add(key)
          patterns.push({ suffix: "", type })
        }
      }
    }

    // Pattern 2: field :"#{blockVar}<suffix>", Type  (interpolated symbol)
    const interpRe = new RegExp(
      `\\bfield\\s+:"#\\{${blockVar}\\}([^"]*)"\\s*,\\s*([A-Z]\\w*)`
    )
    const interpM = line.match(interpRe)
    if (interpM) {
      const suffix = interpM[1] // e.g. "_average" or "_percentage"
      const type = normalizeRubyType(interpM[2])
      if (type) {
        const key = `${suffix}|${type}`
        if (!seen.has(key)) {
          seen.add(key)
          patterns.push({ suffix, type })
        }
      }
    }
  }

  return patterns
}

/**
 * Scan Ruby content and return all DynamicFieldBlock descriptors for `.each` blocks
 * that generate fields. This is called at parse-time (single-file).
 *
 * Handled patterns:
 *   SomeClass.method_name.each do |col|           (useKeys: false — method returns array)
 *   SomeClass::Nested.method_name.keys.each do |col| (useKeys: true — method returns hash)
 *   %i[field1 field2].each do |col|               (inline array — values directly available)
 */
export function detectDynamicFieldBlocks(content: string): DynamicFieldBlock[] {
  const blocks: DynamicFieldBlock[] = []
  const lines = content.split("\n")

  // Pattern 1: ClassName.method(.keys)?.each do |var|
  const methodCallRe = /([\w:]+)\.([\w]+)(\.keys)?\.each\s+do\s+\|\s*(\w+)\s*\|/

  // Pattern 2: %i[symbols].each do |var| or %w[words].each do |var|
  const inlineArrayRe = /(%[iw]\[([^\]]+)\])\.each\s+do\s+\|\s*(\w+)\s*\|/

  for (let i = 0; i < lines.length; i++) {
    const methodMatch = lines[i].match(methodCallRe)
    if (methodMatch) {
      const className = methodMatch[1]
      const methodName = methodMatch[2]
      const useKeys = Boolean(methodMatch[3])
      const blockVar = methodMatch[4]

      const innerLines = extractDoBlockInnerLines(lines, i)
      const patterns = extractFieldPatternsFromBlock(innerLines, blockVar)

      if (patterns.length > 0) {
        blocks.push({ className, methodName, useKeys, blockVar, patterns })
      }
      continue
    }

    // Try inline array pattern
    const inlineMatch = lines[i].match(inlineArrayRe)
    if (inlineMatch) {
      const arrayStr = inlineMatch[1] // e.g., "%i[shifts created_on_appointments]"
      const symbolsContent = inlineMatch[2] // e.g., "shifts created_on_appointments"
      const blockVar = inlineMatch[3] // e.g., "column"

      // Extract individual symbols from the array
      const inlineValues = symbolsContent
        .split(/[\s\n,]+/)
        .map(s => s.trim())
        .filter(s => s.match(/^\w+$/))

      if (inlineValues.length > 0) {
        const innerLines = extractDoBlockInnerLines(lines, i)
        const patterns = extractFieldPatternsFromBlock(innerLines, blockVar)

        if (patterns.length > 0) {
          blocks.push({
            useKeys: false,
            blockVar,
            patterns,
            inlineValues,
          })
        }
      }
    }
  }

  return blocks
}

/**
 * Given a Ruby class name like "CustomerDevelopmentCommunityPerformanceAggregate" or
 * "CustomerDevelopmentCommunityPerformanceAggregate::Row", find a .rb source file
 * whose name matches the snake_case version of the class name.
 *
 * For nested classes (e.g., "Outer::Inner"), tries the outer class first since
 * nested classes are typically defined in the same file as their outer class.
 */
function findFileForClassName(
  basePath: string,
  className: string
): string | null {
  // CamelCase → snake_case converter
  const camelToSnake = (name: string): string =>
    name
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z])([A-Z])/g, "$1_$2")
      .toLowerCase()

  // Build list of file names to try, in priority order
  const filesToTry: string[] = []

  // For nested classes (e.g., "Outer::Inner"), try the outer class first
  if (className.includes("::")) {
    const outerClass = className.split("::")[0]
    filesToTry.push(`${camelToSnake(outerClass)}.rb`)
  }

  // Always try the last component as well
  const lastComponent = className.split("::").pop() || className
  filesToTry.push(`${camelToSnake(lastComponent)}.rb`)

  function walk(dir: string, depth: number): string | null {
    if (depth > 12) return null
    let entries: import("fs").Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return null
    }
    for (const entry of entries) {
      if (
        entry.name === "node_modules" ||
        entry.name === ".git" ||
        entry.name === "tmp" ||
        entry.name === "vendor" ||
        entry.name === "spec" ||
        entry.name === "test"
      )
        continue
      const fullPath = path.join(dir, entry.name)
      // Check if this file matches any of our target filenames
      if (entry.isFile() && filesToTry.includes(entry.name)) return fullPath
      if (entry.isDirectory()) {
        const found = walk(fullPath, depth + 1)
        if (found) return found
      }
    }
    return null
  }

  return walk(basePath, 0)
}

/**
 * From a block of Ruby content (after the method def), extract field names.
 * useKeys=false: method returns %i[name1 name2 ...] or [name1, name2, ...]
 * useKeys=true:  method returns a hash { name1: ..., name2: ... }; return the keys
 */
function extractNamesFromMethodBody(
  afterMethodDef: string,
  useKeys: boolean
): string[] {
  if (!useKeys) {
    // Look for %i[field1\n  field2\n  field3]
    const symArrayMatch = afterMethodDef.match(/%i\[([^\]]+)\]/)
    if (symArrayMatch) {
      return symArrayMatch[1]
        .split(/[\s\n,]+/)
        .map(s => s.trim())
        .filter(s => s.match(/^\w+$/))
    }
    // Look for plain Ruby array: %w[...] or [:name, :name, ...]
    const wArrayMatch = afterMethodDef.match(/%w\[([^\]]+)\]/)
    if (wArrayMatch) {
      return wArrayMatch[1].split(/\s+/).filter(s => s)
    }
  } else {
    // Extract hash keys { key1: ..., key2: ... }
    const hashMatch = afterMethodDef.match(/\{([^}]+)\}/)
    if (hashMatch) {
      const keys: string[] = []
      const keyRe = /(\w+):/g
      let m: RegExpExecArray | null
      while ((m = keyRe.exec(hashMatch[1])) !== null) {
        keys.push(m[1])
      }
      return keys
    }
  }
  return []
}

/**
 * Resolve a single DynamicFieldBlock to concrete FieldDefinitions.
 * For inline arrays, uses the values directly.
 * For method calls, searches allContent for the method definition,
 * then falls back to a targeted filesystem search using basePath.
 */
function resolveDynamicBlock(
  block: DynamicFieldBlock,
  allContent: string,
  basePath: string
): FieldDefinition[] {
  const { className, methodName, useKeys, patterns, inlineValues } = block
  const fields: FieldDefinition[] = []

  let fieldNames: string[] = []

  // Case 1: Inline array — values are directly available
  if (inlineValues && inlineValues.length > 0) {
    fieldNames = inlineValues
  }
  // Case 2: Method call — need to resolve through files
  else if (className && methodName) {
    // Build a corpus: all loaded content + possibly the model file
    let corpus = allContent

    // If method not found in all loaded content, search for the model file
    if (!new RegExp(`def\\s+self\\.${methodName}\\b`).test(corpus)) {
      const modelFile = findFileForClassName(basePath, className)
      if (modelFile) {
        try {
          corpus = fs.readFileSync(modelFile, "utf-8")
        } catch {
          return []
        }
      } else {
        return []
      }
    }

    // Find the method definition
    const methodMatch = corpus.match(
      new RegExp(`def\\s+self\\.${methodName}\\b`, "m")
    )
    if (!methodMatch) return []

    const afterDef = corpus.substring(methodMatch.index!)
    fieldNames = extractNamesFromMethodBody(afterDef, useKeys)
  } else {
    return []
  }

  if (fieldNames.length === 0) return []

  // For each discovered field name × each field pattern, generate a FieldDefinition
  for (const fieldName of fieldNames) {
    for (const pattern of patterns) {
      const fullName = fieldName + pattern.suffix
      fields.push({
        name: snakeToCamel(fullName),
        type: pattern.type,
        nullable: true,
        isList: false,
        listDepth: 0,
        access: ["private"],
        description: inlineValues
          ? `Generated from inline array`
          : `Generated from ${className}.${methodName}`,
      })
    }
  }

  return fields
}

/**
 * Second-pass: resolve all DynamicFieldBlocks on each type definition.
 * Modifies typeDef.fields in-place by appending the generated fields.
 * Must be called after all type files have been loaded.
 *
 * @param typeDefs  All parsed type definitions (may include ones with dynamicFieldBlocks)
 * @param allFiles  Map of filePath → content for all loaded files
 * @param basePath  Workspace root for fallback model file discovery
 */
export function resolveDynamicFields(
  typeDefs: GraphQLTypeDefinition[],
  allFiles: Map<string, string>,
  basePath: string
): void {
  // Concatenate all loaded content once for fast searching
  const allContent = [...allFiles.values()].join("\n")

  for (const typeDef of typeDefs) {
    if (!typeDef.dynamicFieldBlocks || typeDef.dynamicFieldBlocks.length === 0)
      continue

    for (const block of typeDef.dynamicFieldBlocks) {
      const generated = resolveDynamicBlock(block, allContent, basePath)
      if (generated.length > 0) {
        // Avoid duplicating fields already declared statically
        const existingNames = new Set(typeDef.fields.map(f => f.name))
        for (const f of generated) {
          if (!existingNames.has(f.name)) {
            typeDef.fields.push(f)
            existingNames.add(f.name)
          }
        }
      }
    }

    // Clear to avoid re-processing
    delete typeDef.dynamicFieldBlocks
  }
}

/**
 * Parse field definitions from Ruby content.
 */
function parseFields(
  content: string,
  kind: GraphQLTypeDefinition["kind"] = "object"
): FieldDefinition[] {
  const fields: FieldDefinition[] = []

  // Match field declarations — Pattern: field :name, Type, options...
  const fieldRegex = /field\s+:(\w+)\s*,\s*(.+)/g

  let match: RegExpExecArray | null
  while ((match = fieldRegex.exec(content)) !== null) {
    const fieldName = match[1]
    const rest = match[2]

    const parsed = parseFieldRest(rest)
    if (parsed) {
      fields.push({
        name: parsed.camelize !== false ? snakeToCamel(fieldName) : fieldName,
        ...parsed,
      })
    }
  }

  // Match belongs_to / has_one declarations — single (non-list) association
  // Pattern: belongs_to :name, ::Module::TypeClass, null: false
  const singleAssocRegex = /(?:belongs_to|has_one)\s+:(\w+)\s*,\s*(.+)/g
  while ((match = singleAssocRegex.exec(content)) !== null) {
    const fieldName = match[1]
    const rest = match[2]
    const parsed = parseFieldRest(rest)
    if (parsed) {
      fields.push({
        name: parsed.camelize !== false ? snakeToCamel(fieldName) : fieldName,
        ...parsed,
        isList: false, // belongs_to is always singular
        listDepth: 0, // no list nesting
      })
    }
  }

  // Match has_many declarations — list association
  // Pattern: has_many :name, [::Module::TypeClass]
  const hasManyRegex = /has_many\s+:(\w+)\s*,\s*(.+)/g
  while ((match = hasManyRegex.exec(content)) !== null) {
    const fieldName = match[1]
    const rest = match[2]
    const parsed = parseFieldRest(rest)
    if (parsed) {
      fields.push({
        name: parsed.camelize !== false ? snakeToCamel(fieldName) : fieldName,
        ...parsed,
        isList: true, // has_many is always a list
        listDepth: 1, // single-level list
      })
    }
  }

  // Match has_one_attached declarations — Active Storage single attachment
  // Pattern: has_one_attached :name, ::Module::TypeClass, options...
  const hasOneAttachedRegex = /has_one_attached\s+:(\w+)\s*,\s*(.+)/g
  while ((match = hasOneAttachedRegex.exec(content)) !== null) {
    const fieldName = match[1]
    const rest = match[2]
    const parsed = parseFieldRest(rest)
    if (parsed) {
      fields.push({
        name: parsed.camelize !== false ? snakeToCamel(fieldName) : fieldName,
        ...parsed,
        isList: false, // has_one_attached is always singular
        listDepth: 0, // no list nesting
      })
    }
  }

  // Match has_many_attached declarations — Active Storage multiple attachments
  // Pattern: has_many_attached :name, [::Module::TypeClass], options...
  const hasManyAttachedRegex = /has_many_attached\s+:(\w+)\s*,\s*(.+)/g
  while ((match = hasManyAttachedRegex.exec(content)) !== null) {
    const fieldName = match[1]
    const rest = match[2]
    const parsed = parseFieldRest(rest)
    if (parsed) {
      fields.push({
        name: parsed.camelize !== false ? snakeToCamel(fieldName) : fieldName,
        ...parsed,
        isList: true, // has_many_attached is always a list
        listDepth: 1, // single-level list
      })
    }
  }

  // Match has_and_belongs_to_many declarations — many-to-many association
  // Pattern: has_and_belongs_to_many :name, [::Module::TypeClass], options...
  const habtmRegex = /has_and_belongs_to_many\s+:(\w+)\s*,\s*(.+)/g
  while ((match = habtmRegex.exec(content)) !== null) {
    const fieldName = match[1]
    const rest = match[2]
    const parsed = parseFieldRest(rest)
    if (parsed) {
      fields.push({
        name: parsed.camelize !== false ? snakeToCamel(fieldName) : fieldName,
        ...parsed,
        isList: true, // has_and_belongs_to_many is always a list
        listDepth: 1, // single-level list
      })
    }
  }

  // Match argument declarations — used in input types ONLY.
  // Object/interface types use `field` declarations; `argument` only appears as
  // class-level fields on input types.  Inline arguments inside
  // `field :name do argument :x ... end` blocks on other types must NOT be
  // picked up here — they are field-level arguments, not type fields.
  if (kind === "input") {
    const argRegex = /argument\s+:(\w+)\s*,\s*(.+)/g
    while ((match = argRegex.exec(content)) !== null) {
      const fieldName = match[1]
      const rest = match[2]

      let listDepth = 0
      let isList = false
      let typePart: string

      if (rest.trim().startsWith("[")) {
        // Count nested list depth by finding opening and closing brackets
        const leadingBrackets = rest.match(/^\s*(\[+)/)
        if (!leadingBrackets) continue
        const openBrackets = leadingBrackets[1].length
        const bracketsStart = leadingBrackets[0].length

        // Find matching closing brackets
        const afterOpenBrackets = rest.substring(bracketsStart)
        const trailingBrackets = afterOpenBrackets.match(/(\]+)(\s|,|$)/)
        if (!trailingBrackets) continue
        const closeBrackets = trailingBrackets[1].length
        const closeBracketsStart = afterOpenBrackets.indexOf(
          trailingBrackets[1]
        )

        // Extract the type between brackets
        const innerContent = afterOpenBrackets
          .substring(0, closeBracketsStart)
          .trim()

        isList = true
        listDepth = Math.min(openBrackets, closeBrackets)
        typePart = innerContent
      } else {
        typePart = rest.split(",")[0].trim()
      }

      const type = normalizeRubyType(typePart)
      if (!type) continue

      const requiredMatch = rest.match(/required:\s*(true|false)/)
      // required: true → not nullable; required: false or unspecified → nullable
      const nullable = requiredMatch ? requiredMatch[1] === "false" : true

      fields.push({
        name: snakeToCamel(fieldName),
        type,
        nullable,
        isList,
        listDepth,
        access: ["private"],
      })
    }
  }

  // Attach inline field-level arguments from `field :name do...end` blocks.
  // These are args on object/interface fields (e.g. `argument :code, [String]`
  // inside a field block), needed so validation accepts them on query fields.
  const fieldArgMap = parseFieldBlockArgs(content)
  for (const field of fields) {
    const args = fieldArgMap.get(field.name)
    if (args && args.length > 0) {
      field.fieldArgs = args
    }
  }

  return fields
}

interface ParsedFieldRest {
  type: string
  nullable: boolean
  isList: boolean
  /** Nesting depth for lists; e.g. [[Type]] has listDepth=2, [Type] has listDepth=1 */
  listDepth: number
  access: AccessLevel
  description?: string
  /** Full Ruby path of the field type for namespace disambiguation */
  typeRubyPath?: string
  /** Resolver class name for `field :name, resolver: Class` syntax */
  resolverClassName?: string
  /** Whether the field name should be camelCased (default: true) */
  camelize?: boolean
  /** Whether this field uses .connection_type (e.g., MyType.connection_type) */
  isConnectionType?: boolean
}

/**
 * Parse the remainder of a field declaration after the name.
 * e.g. "String, null: false, access: :public"
 */
function parseFieldRest(rest: string): ParsedFieldRest | null {
  // Strip inline comments — e.g., `field :name, Type # TODO: comment` → `field :name, Type`
  // This prevents comments from being parsed as part of the type name
  rest = rest.split("#")[0].trim()

  // Strip trailing `do` keyword — some field declarations open a `do...end`
  // block for inline argument declarations, e.g.:
  //   field :pay_period_summary, Craftsman::Graphql::CraftsmanPayPeriodSummaryType do
  // The block arguments are handled separately by parseFieldBlockArgs; here we
  // only care about the type and field-level options.
  rest = rest.replace(/\s+do\s*$/, "")

  // Detect `field :name, resolver: Class`, `mutation: Class`, or `subscription: Class` pattern.
  // When a field delegates to a standalone resolver class, store the class name
  // so the schema builder can wire up its return type and arguments at build time.
  const resolverMatch = rest.match(
    /\b(?:resolver|mutation|subscription):\s+([\w:]+)/
  )
  if (resolverMatch) {
    return {
      type: "String", // placeholder; actual return type resolved at schema-build time
      nullable: true,
      isList: false,
      listDepth: 0,
      access: parseAccessLevel(rest),
      resolverClassName: resolverMatch[1].replace(/^::/, ""),
    }
  }

  // Extract the type — first non-option argument
  // Types look like: String, ID, Boolean, Integer, Float, [SomeType], ::Module::Type
  // For arrays, may include inline options: [SomeType, { null: true }]
  const isList = rest.trim().startsWith("[")

  let listDepth = 0
  let typePart: string

  if (isList) {
    // Extract nested list structure: [[Type]], [Type], etc.
    // Count opening brackets at the start, then find the matching closing brackets.
    const leadingBrackets = rest.match(/^\s*(\[+)/)
    if (!leadingBrackets) {
      return null
    }
    const openBrackets = leadingBrackets[1].length
    const bracketsStart = leadingBrackets[0].length

    // Find matching closing brackets by counting from the back
    const afterOpenBrackets = rest.substring(bracketsStart)
    const trailingBrackets = afterOpenBrackets.match(/(\]+)\s*(,|$)/)
    if (!trailingBrackets) {
      return null
    }
    const closeBrackets = trailingBrackets[1].length
    const closeBracketsStart = afterOpenBrackets.indexOf(trailingBrackets[1])

    // The type is between the opening and closing brackets
    // e.g., for [[Type]], innterContent is "Type"
    // e.g., for [Type], innerContent is "Type"
    const innerContent = afterOpenBrackets
      .substring(0, closeBracketsStart)
      .trim()

    // Count actual nesting depth (both opening and closing must match for proper nesting)
    listDepth = Math.min(openBrackets, closeBrackets)

    // Inside brackets, there may be a type followed by comma and inline options: Type, { null: true }
    // We only care about the type part, so split on comma and take the first element
    typePart = innerContent.split(",")[0].trim()
  } else {
    // Get everything up to the first comma or end
    const parts = rest.split(",")
    typePart = parts[0].trim()
    // Strip quotes if the type was passed as a string literal (e.g., "::Module::Type")
    // This handles both single and double quotes
    typePart = typePart.replace(/^["']|["']$/g, "").trim()
  }

  // Detect .connection_type suffix (e.g., MyType.connection_type)
  // This indicates the field should be wrapped in a Relay connection type with pagination args
  const isConnectionType = typePart.includes(".connection_type")
  const baseTypePart = isConnectionType
    ? typePart.replace(/\.connection_type$/, "").trim()
    : typePart

  // Preserve the full Ruby path before normalising — used at schema-build time
  // to look up the exact graphql_name in rubyPathMap when two namespaces define
  // a class with the same short name (e.g. Directory::EquipmentAssetType vs
  // EquipmentAssets::EquipmentAssetType both normalise to "EquipmentAsset").
  const typeRubyPath = baseTypePart.includes("::")
    ? baseTypePart.replace(/^::/, "").trim()
    : undefined

  // Clean up type — remove Ruby namespacing
  const type = normalizeRubyType(baseTypePart)
  if (!type) {
    return null
  }

  // Extract the field-level options that come after the type definition.
  // For list types like [Type, { null: true }], we want to ignore inline options { null: true }
  // and only parse the field-level options that come after the bracket.
  let optionsString = rest
  if (isList) {
    // Find the closing bracket and use everything after it
    const closingBracketIdx = rest.indexOf("]")
    if (closingBracketIdx !== -1) {
      optionsString = rest.substring(closingBracketIdx + 1)
    }
  } else {
    // For non-list types, skip past the type name to get to the options
    // This is the part after the first comma, or we can just use rest which contains `, options...`
    const firstCommaIdx = rest.indexOf(",")
    if (firstCommaIdx !== -1) {
      optionsString = rest.substring(firstCommaIdx)
    }
  }

  // Parse null: option from field-level options only
  const nullMatch = optionsString.match(/null:\s*(true|false)/)
  const nullable = nullMatch ? nullMatch[1] === "true" : true

  // Parse access: option
  const access = parseAccessLevel(optionsString)

  // Extract description: option
  const descriptionMatch = optionsString.match(
    /description:\s*["']([^"']+)["']/
  )
  const description = descriptionMatch ? descriptionMatch[1] : undefined

  // Parse camelize: option (default is true — field names are camelCased unless explicitly disabled)
  const camelizeMatch = optionsString.match(/camelize:\s*(true|false)/)
  const camelize = camelizeMatch ? camelizeMatch[1] === "true" : true

  return {
    type,
    nullable,
    isList,
    listDepth,
    access,
    description,
    typeRubyPath,
    camelize,
    isConnectionType: isConnectionType || undefined,
  }
}

/**
 * Normalize a Ruby type reference to a GraphQL type name.
 */
function normalizeRubyType(rubyType: string): string | null {
  const cleaned = rubyType.trim()

  // Handle Ruby constant paths like ::LearningDojo::Graphql::CourseVersionType
  if (cleaned.includes("::")) {
    const parts = cleaned.split("::")

    // Special handling for GraphQL gem's built-in scalars from graphql-ruby gem.
    // GraphQL::Types::ISO8601DateTime, GraphQL::Types::ISO8601Date, etc. are
    // provided by graphql-ruby and map to known GraphQL scalars.
    if (parts[0] === "GraphQL" && parts[1] === "Types") {
      const typeName = parts[parts.length - 1]

      // Map graphql-ruby built-in types to GraphQL scalars
      const graphqlTypeMap: Record<string, string> = {
        ISO8601DateTime: "DateTime",
        ISO8601Date: "Date",
        ISO8601Time: "Time",
        JSON: "Json",
        BigInt: "BigInt",
      }

      if (graphqlTypeMap[typeName]) {
        return graphqlTypeMap[typeName]
      }

      // If not in the map, still use the type name as-is in case it's a custom
      // GraphQL type that happens to be under the GraphQL::Types namespace
      return typeName
    }

    // For other namespaced types (custom user types), use the last part
    const last = parts[parts.length - 1]
    return deriveTypeName(last)
  }

  // Map Ruby scalar types to GraphQL types
  const scalarMap: Record<string, string> = {
    String: "String",
    Integer: "Int",
    Int: "Int",
    Float: "Float",
    Boolean: "Boolean",
    ID: "ID",
  }

  if (scalarMap[cleaned]) {
    return scalarMap[cleaned]
  }

  // Return as-is for custom types
  return deriveTypeName(cleaned)
}

/**
 * Parse the access level from a field option string.
 */
export function parseAccessLevel(optionString: string): AccessLevel {
  // Match access: :public or access: :private etc.
  const symbolMatch = optionString.match(/access:\s+:(\w+)/)
  if (symbolMatch) {
    return [symbolMatch[1]]
  }

  // Match access: %i[private customer]
  const arrayMatch = optionString.match(/access:\s+%i\[([^\]]+)\]/)
  if (arrayMatch) {
    return arrayMatch[1].trim().split(/\s+/)
  }

  // Match access: %w[private customer]
  const wordArrayMatch = optionString.match(/access:\s+%w\[([^\]]+)\]/)
  if (wordArrayMatch) {
    return wordArrayMatch[1].trim().split(/\s+/)
  }

  // Match access: [:private, :customer]
  const rubyArrayMatch = optionString.match(/access:\s+\[([^\]]+)\]/)
  if (rubyArrayMatch) {
    return rubyArrayMatch[1]
      .split(",")
      .map(s => s.trim().replace(/^:/, ""))
      .filter(Boolean)
  }

  // Default: private (auth required)
  return ["private"]
}

// ── Resolver Parsing ───────────────────────────────────────────────────────────

/**
 * Convert snake_case to camelCase, including cases where the segment after
 * an underscore is a number (e.g., street_address_1 → streetAddress1).
 */
export function snakeToCamel(snake: string): string {
  return snake.replace(/_(.)/g, (_, c) => c.toUpperCase())
}

/**
 * Extract description from Ruby content.
 * Looks for: description "Some text" or description 'Some text'
 */
function extractDescription(content: string): string | undefined {
  const match = content.match(/description\s+["']([^"']+)["']/)
  return match ? match[1] : undefined
}

/**
 * Parse a Ruby mixin module file that provides arguments via `self.included`.
 * Returns the full module path and the arguments it contributes, or null if
 * this file doesn't look like an argument-providing mixin.
 *
 * Example mixin:
 *   module NitroGraphql
 *     module PaginationArguments
 *       def self.included(cls)
 *         cls.class_eval do
 *           argument :page, Integer, required: false, default_value: 1
 *         end
 *       end
 *     end
 *   end
 */
export function parseMixinArguments(
  fileContent: string
): { modulePath: string; arguments: ArgumentDefinition[] } | null {
  // Skip non-Ruby files (e.g., TypeScript/JavaScript)
  if (isJavaScriptFile(fileContent)) {
    return null
  }

  const lines = fileContent.split("\n")
  const contentLines = lines.filter(l => !l.trim().startsWith("#"))
  const content = contentLines.join("\n")

  // Must have a self.included block — that's what makes it an argument-providing mixin
  if (!content.includes("self.included")) {
    return null
  }

  // Must have at least one argument declaration
  if (!content.includes("argument ")) {
    return null
  }

  // Collect module names in order of declaration to build the full path
  const modules: string[] = []
  const moduleRegex = /module\s+([\w:]+)/g
  let modMatch: RegExpExecArray | null
  while ((modMatch = moduleRegex.exec(content)) !== null) {
    modules.push(modMatch[1])
  }

  if (modules.length === 0) {
    return null
  }

  const modulePath = modules.join("::")

  // Extract the self.included / class_eval block content
  // We grab everything between self.included and its matching end so that
  // argument declarations inside `do...end` validation blocks are included.
  const includedStart = content.indexOf("self.included")
  const includedContent = content.substring(includedStart)

  const args = parseArguments(includedContent)
  if (args.length === 0) {
    return null
  }

  return { modulePath, arguments: args }
}

/**
 * Build a mixin registry from all loaded Ruby files.
 * Maps full Ruby module path → argument list for every mixin that provides arguments.
 */
export function parseMixinRegistry(
  files: Map<string, string>
): Map<string, ArgumentDefinition[]> {
  const registry = new Map<string, ArgumentDefinition[]>()
  for (const [, content] of files) {
    const mixin = parseMixinArguments(content)
    if (mixin) {
      registry.set(mixin.modulePath, mixin.arguments)
    }
  }
  return registry
}

/**
 * Parse a Ruby resolver class (BaseQuery subclass) into a ResolverDefinition.
 * These classes define `argument` declarations and a `type` return.
 */
export function parseResolverDefinition(
  fileContent: string,
  fileName: string,
  mixinRegistry: Map<string, ArgumentDefinition[]> = new Map()
): ResolverDefinition | null {
  // Skip non-Ruby files (e.g., TypeScript/JavaScript)
  if (isJavaScriptFile(fileContent)) {
    return null
  }

  const lines = fileContent.split("\n")
  const contentLines = lines.filter(l => !l.trim().startsWith("#"))
  const content = contentLines.join("\n")

  // Extract all class definitions from the file
  const classRegex = /class\s+(\w+)\s*<\s*([\w:]+)/g
  let classMatch: RegExpExecArray | null
  let resolverMatch: RegExpExecArray | null = null
  let resolverClassName: string = ""
  let resolverParentClass: string = ""

  // Find the first class that is a valid resolver class
  while ((classMatch = classRegex.exec(content)) !== null) {
    const className = classMatch[1]
    const parentClass = classMatch[2]

    if (isResolverClass(parentClass, className)) {
      resolverMatch = classMatch
      resolverClassName = className
      resolverParentClass = parentClass
      break
    }
  }

  if (!resolverMatch) {
    return null
  }

  const className = resolverClassName
  const parentClass = resolverParentClass

  // Derive the full class name from module nesting
  const modules: string[] = []
  const moduleRegex = /module\s+([\w:]+)/g
  let modMatch: RegExpExecArray | null
  while ((modMatch = moduleRegex.exec(content)) !== null) {
    modules.push(modMatch[1])
  }
  const fullClassName = [...modules, className].join("::")

  // Parse return type. Supports three forms:
  //   type [SomeType], null: false           → list (connection)
  //   type [[SomeType]], null: false         → nested list
  //   type SomeType.connection_type, null: false  → explicit connection
  //   type SomeType, null: false             → single object
  // Match: optional brackets, type name, optional brackets, optional .connection_type, optional comma + options
  const typeMatch = content.match(
    /^\s*type\s+((?:\[+)?[:\w]+(?:\]+)?(?:\.connection_type)?)\s*,?\s*(.*?)$/m
  )
  let returnType = "String"
  let returnTypeRubyPath: string | undefined
  let returnTypeIsList = false
  let returnTypeListDepth = 0
  let returnTypeNullable = true

  if (typeMatch) {
    const rawType = typeMatch[1].trim()
    const typeOpts = typeMatch[2] || ""

    const isConnectionType = rawType.endsWith(".connection_type")

    // Calculate list depth
    if (rawType.startsWith("[")) {
      const bracketMatch = rawType.match(/^(\[+)/)
      if (bracketMatch) {
        returnTypeListDepth = bracketMatch[1].length
        returnTypeIsList = true
      }
    }

    // Strip brackets and .connection_type suffix to get the base type name
    const typeStr = rawType
      .replace(/^\.connection_type$/, "")
      .replace(/\.connection_type$/, "")
      .replace(/^\[+|\]+$/g, "")
      .trim()
    returnType = normalizeRubyType(typeStr) || "String"

    // Preserve the full Ruby path for namespace-aware resolution in the schema builder.
    if (typeStr.includes("::")) {
      // Explicitly namespaced — store the path as-is (strip leading ::).
      returnTypeRubyPath = typeStr.replace(/^::/, "")
    } else if (modules.length > 0) {
      // Unqualified type reference (e.g. `type ActivityType, null: false`).
      // Ruby resolves this by looking in the enclosing module namespace first.
      // Store a candidate path scoped to this resolver's namespace so the schema
      // builder can prefer it over a same-named type in a different component.
      // e.g. resolver in Craftsman::Graphql + ActivityType → Craftsman::Graphql::ActivityType
      returnTypeRubyPath = [...modules, typeStr].join("::")
    }

    const nullMatch = typeOpts.match(/null:\s*(true|false)/)
    returnTypeNullable = nullMatch ? nullMatch[1] === "true" : true
  }

  // Parse arguments declared directly on this resolver
  const args = parseArguments(content)

  // Detect `include SomeModule` statements and merge arguments from the mixin registry.
  // Ruby resolves unqualified module names in the enclosing namespace first, then
  // outer scopes; we try the fully-qualified path first (e.g. NitroGraphql::PaginationArguments
  // from `include NitroGraphql::PaginationArguments`) and also fall back to a
  // namespace-scoped candidate when the include is unqualified.
  const includeRegex = /\binclude\s+([\w:]+)/g
  let includeMatch: RegExpExecArray | null
  const seenMixinArgs = new Set<string>(args.map(a => a.name))
  while ((includeMatch = includeRegex.exec(content)) !== null) {
    const rawInclude = includeMatch[1].replace(/^::/, "")
    // Try the literal include path first, then scoped variants
    const candidates = [rawInclude]
    if (!rawInclude.includes("::") && modules.length > 0) {
      candidates.push([...modules, rawInclude].join("::"))
    }
    for (const candidate of candidates) {
      const mixinArgs = mixinRegistry.get(candidate)
      if (mixinArgs) {
        for (const arg of mixinArgs) {
          // Own arguments take precedence over mixin arguments
          if (!seenMixinArgs.has(arg.name)) {
            args.push(arg)
            seenMixinArgs.add(arg.name)
          }
        }
        break
      }
    }
  }

  // Extract description
  const description = extractDescription(content)

  const isConnectionType = typeMatch
    ? typeMatch[1].trim().endsWith(".connection_type")
    : false

  // Normalise the parent class: strip leading :: so the inheritance walker
  // can match against stored class names (which never carry the leading ::).
  const fullParentClass = parentClass.replace(/^::/, "")

  return {
    className: fullClassName,
    parentClass: fullParentClass,
    returnType,
    returnTypeRubyPath,
    returnTypeIsList,
    returnTypeListDepth,
    isConnectionType,
    returnTypeNullable,
    arguments: args,
    fileName,
    description,
  }
}

/**
 * Walk the resolver parent-class chain and merge ancestor arguments into each
 * resolver's own argument list.  This handles patterns like:
 *
 *   class UpdateReviewMutationBase < NitroGraphql::BaseMutation
 *     argument :review_id, ID, required: true
 *   end
 *
 *   class UpdateQuarterlyReviewMutation < EmployeeReviews::Graphql::UpdateReviewMutationBase
 *     argument :input, QuarterlyReviewInput
 *   end
 *
 * After resolution UpdateQuarterlyReviewMutation.arguments includes both
 * :input (own) and :review_id (inherited).
 *
 * A resolver's own arguments always take precedence over parent arguments.
 * If a resolver doesn't declare a return type (still "String" with no ruby
 * path) it also inherits the parent's return type.
 */
export function resolveResolverInheritance(
  resolvers: ResolverDefinition[]
): void {
  // Build a lookup map keyed by full class name.
  const byClassName = new Map<string, ResolverDefinition>()
  for (const r of resolvers) {
    byClassName.set(r.className, r)
  }

  // Find a resolver in the registry by exact match or namespace-aware suffix.
  function findParent(parentClass: string): ResolverDefinition | undefined {
    if (byClassName.has(parentClass)) return byClassName.get(parentClass)
    // Suffix match — handles cases where the parent reference was written as a
    // shorter qualified name (e.g. "Graphql::UpdateReviewMutationBase") but the
    // stored key is the full path.
    const tail = parentClass.split("::").pop()!
    for (const [key, r] of byClassName) {
      if (key === tail || key.endsWith("::" + tail)) {
        const parentSegs = parentClass.split("::")
        const keySegs = key.split("::")
        if (
          keySegs.length >= parentSegs.length &&
          keySegs.slice(keySegs.length - parentSegs.length).join("::") ===
            parentClass
        ) {
          return r
        }
      }
    }
    return undefined
  }

  const visited = new Set<string>()

  function ensureInherited(resolver: ResolverDefinition): void {
    if (visited.has(resolver.className)) return
    visited.add(resolver.className)

    const parent = findParent(resolver.parentClass)
    if (!parent) return // Parent not in our parsed set — nothing to inherit

    // Resolve parent's own inheritance first (depth-first)
    ensureInherited(parent)

    // Merge parent arguments — child's own args take precedence
    const ownArgNames = new Set(resolver.arguments.map(a => a.name))
    for (const parentArg of parent.arguments) {
      if (!ownArgNames.has(parentArg.name)) {
        resolver.arguments.push(parentArg)
        ownArgNames.add(parentArg.name)
      }
    }

    // Inherit return type if the child resolver has none of its own
    if (
      resolver.returnType === "String" &&
      !resolver.returnTypeRubyPath &&
      (parent.returnType !== "String" || parent.returnTypeRubyPath)
    ) {
      resolver.returnType = parent.returnType
      resolver.returnTypeRubyPath = parent.returnTypeRubyPath
      resolver.returnTypeIsList = parent.returnTypeIsList
      resolver.returnTypeListDepth = parent.returnTypeListDepth
      resolver.returnTypeNullable = parent.returnTypeNullable
      resolver.isConnectionType = parent.isConnectionType
    }
  }

  for (const resolver of resolvers) {
    ensureInherited(resolver)
  }
}

/**
 * Parse `argument` declarations from Ruby resolver content.
 * Format: `argument :name, Type, required: false, default_value: "x"`
 * Supports multi-line argument definitions.
 */
export function parseArguments(content: string): ArgumentDefinition[] {
  const args: ArgumentDefinition[] = []

  // Split content by "argument " to find each argument declaration.
  // Each part starts with `:name, ...` after the split.
  const parts = content.split(/\bargument\s+/)

  for (const part of parts) {
    // Skip empty parts and the first part (before any "argument" keyword)
    if (!part.trim()) continue

    // Extract argument name (first :word)
    const nameMatch = part.match(/^:(\w+)\s*,/)
    if (!nameMatch) continue

    const argName = nameMatch[1]
    // Get everything after ":name,"
    const rest = part.substring(nameMatch[0].length)

    const parsed = parseArgumentRest(rest)
    if (parsed) {
      args.push({
        name: snakeToCamel(argName),
        ...parsed,
      })
    }
  }

  return args
}

interface ParsedArgumentRest {
  type: string
  typeRubyPath?: string
  required: boolean
  isList: boolean
  listDepth: number
  defaultValue?: string
}

/**
 * Parse the remainder of an argument declaration after the name.
 * Handles both single-line and multi-line argument definitions.
 */
function parseArgumentRest(rest: string): ParsedArgumentRest | null {
  // Truncate at the next `argument`, `def`, `type`, `private`, `protected`, or `end` keyword
  // to avoid consuming content from subsequent methods, type declarations, or arguments
  const terminatorMatch = rest.match(
    /(?=\bargument\s+|\bdef\s+|\btype\s+|\bprivate\s+|\bprotected\s+|\bend\b)/
  )
  let workingContent = rest
  if (terminatorMatch && terminatorMatch.index !== undefined) {
    workingContent = rest.substring(0, terminatorMatch.index)
  }

  // Clean up the content: normalize newlines and multiple spaces
  const cleaned = workingContent.replace(/\s+/g, " ").trim()

  // Count nesting depth and check for lists
  let listDepth = 0
  let typePart: string

  if (cleaned.startsWith("[")) {
    // Extract nested list structure: [[Type]], [Type], etc.
    const leadingBrackets = cleaned.match(/^(\[+)/)
    if (!leadingBrackets) {
      return null
    }
    const openBrackets = leadingBrackets[1].length
    const bracketsStart = leadingBrackets[0].length

    // Find matching closing brackets
    const afterOpenBrackets = cleaned.substring(bracketsStart)
    const trailingBrackets = afterOpenBrackets.match(/(\]+)(\s|,|$)/)
    if (!trailingBrackets) {
      return null
    }
    const closeBrackets = trailingBrackets[1].length
    const closeBracketsStart = afterOpenBrackets.indexOf(trailingBrackets[1])

    // Extract the type between brackets
    const innerContent = afterOpenBrackets
      .substring(0, closeBracketsStart)
      .trim()

    // Use the minimum to detect nesting depth
    listDepth = Math.min(openBrackets, closeBrackets)
    typePart = innerContent
  } else {
    // Get everything up to first comma or end
    const parts = cleaned.split(",")
    typePart = parts[0].trim()
    // Strip quotes if the type was passed as a string literal (e.g., "::Module::Type")
    // This handles both single and double quotes
    typePart = typePart.replace(/^["']|["']$/g, "").trim()
    // Ruby type paths are [\w:]+ with no whitespace. Strip anything after
    // the first space so that custom DSL methods on the following line
    // (e.g. `review_class Foo::Bar` collapsed into the same comma-less
    // segment) don't corrupt the type name.
    typePart = typePart.match(/^[\w:]+/)?.[0] ?? typePart
  }

  const type = normalizeRubyType(typePart)
  if (!type) {
    return null
  }

  // Preserve the full Ruby path for namespace-aware resolution in the schema builder
  const typeRubyPath = typePart.includes("::")
    ? typePart.replace(/^::/, "")
    : undefined

  // Parse required option — default is true for arguments
  // Use the original `rest` string for regex matching since it has newlines
  const requiredMatch = rest.match(/required:\s*(true|false)/)
  const required = requiredMatch ? requiredMatch[1] === "true" : true

  // Parse default_value option
  const defaultMatch = rest.match(/default_value:\s*["']?([^"',\s]+)["']?/)
  const defaultValue = defaultMatch ? defaultMatch[1] : undefined

  // If there's a default_value, the argument is effectively optional
  const effectiveRequired = defaultValue !== undefined ? false : required

  return {
    type,
    typeRubyPath,
    required: effectiveRequired,
    isList: listDepth > 0,
    listDepth,
    defaultValue,
  }
}

/**
 * Find `field :name ... do\n  argument :x, Type\nend` blocks and return
 * a map of camelCase field name → the declared arguments.
 * Used to attach field-level inline arguments (e.g. on interface/object fields)
 * so that query validation sees the argument as valid.
 */
function parseFieldBlockArgs(
  content: string
): Map<string, ArgumentDefinition[]> {
  const result = new Map<string, ArgumentDefinition[]>()
  const lines = content.split("\n")
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    // Match a field declaration (may or may not have `do` on same line)
    const fieldMatch = line.match(/\bfield\s+:(\w+)/)
    if (fieldMatch) {
      const fieldName = snakeToCamel(fieldMatch[1])
      const baseIndent = (line.match(/^(\s*)/)?.[1] ?? "").length

      // Check if `do` is on the same line
      let doLineIndex = -1
      if (line.includes("do")) {
        doLineIndex = i
      } else {
        // Look ahead for `do` on following lines (reasonable search distance)
        // Multi-line field declarations typically have `do` within 3-5 lines.
        // IMPORTANT: Stop if we encounter another `field` keyword, as that indicates
        // a new field declaration and any `do` found would belong to that field, not this one.
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const lookaheadLine = lines[j]
          // Stop if we hit another field declaration
          if (lookaheadLine.includes("field ")) {
            break
          }
          if (lookaheadLine.includes("do")) {
            doLineIndex = j
            break
          }
        }
      }

      if (doLineIndex !== -1) {
        // Found a `do` block, now parse arguments
        const blockArgs: ArgumentDefinition[] = []
        let argIndex = doLineIndex + 1

        while (argIndex < lines.length) {
          const argLine = lines[argIndex]
          const argTrimmed = argLine.trim()
          const argIndent = (argLine.match(/^(\s*)/)?.[1] ?? "").length

          // Stop at an `end` at or before the field's indentation level
          if (argTrimmed === "end" && argIndent <= baseIndent) break

          const argMatch = argTrimmed.match(/^argument\s+:(\w+)\s*,\s*(.+)/)
          if (argMatch) {
            const parsed = parseArgumentRest(argMatch[2])
            if (parsed) {
              blockArgs.push({
                name: snakeToCamel(argMatch[1]),
                ...parsed,
              })
            }
          }
          argIndex++
        }

        if (blockArgs.length > 0) {
          result.set(fieldName, blockArgs)
        }
      }
    }
    i++
  }

  return result
}

// ── Registration File Parsing ──────────────────────────────────────────────────

/**
 * Parse a component registration file (graphql.rb) to extract resolver registrations.
 * These files wire resolver classes to field names on the root Query/Mutations types.
 *
 * Format:
 *   queries do
 *     field :field_name, resolver: ::Module::ResolverClass
 *   end
 *
 *   mutations do
 *     field :field_name, resolver: ::Module::MutationClass
 *   end
 */
export function parseRegistrationFile(
  fileContent: string
): ResolverRegistration[] {
  const registrations: ResolverRegistration[] = []

  // Extract component namespace from module declaration (e.g., "module TerritoryMaps")
  const moduleMatch = fileContent.match(/^\s*module\s+(\w+)/m)
  const componentNamespace = moduleMatch ? moduleMatch[1] : undefined

  // Split into queries and mutations blocks
  const queriesBlock = extractBlock(fileContent, "queries")
  const mutationsBlock = extractBlock(fileContent, "mutations")

  logger.log(
    `[NitroGraphQL] Registration file: queriesBlock ${queriesBlock ? "found" : "NOT found"}, mutationsBlock ${mutationsBlock ? "found" : "NOT found"}`
  )

  if (queriesBlock) {
    logger.log(
      `[NitroGraphQL] Parsing queries block (${queriesBlock.length} chars)`
    )
    parseRegistrationBlock(
      queriesBlock,
      "query",
      registrations,
      componentNamespace
    )
  }
  if (mutationsBlock) {
    logger.log(
      `[NitroGraphQL] Parsing mutations block (${mutationsBlock.length} chars)`
    )
    parseRegistrationBlock(
      mutationsBlock,
      "mutation",
      registrations,
      componentNamespace
    )
  }

  return registrations
}

/**
 * Extract a block between `name do` and its matching `end`.
 * Properly handles nested `do...end` blocks (e.g., field argument blocks).
 */
function extractBlock(content: string, blockName: string): string | null {
  // Find the start of the block: "name do"
  const blockStartRegex = new RegExp(`\\b${blockName}\\s+do\\b`)
  const startMatch = blockStartRegex.exec(content)

  if (!startMatch) {
    return null
  }

  // Start searching after the opening 'do'
  const searchStart = startMatch.index + startMatch[0].length
  const blockContent = content.substring(searchStart)

  // Count nested do...end pairs to find the matching closing 'end'
  const keywordRegex = /\b(do|end)\b/gi
  let depth = 1 // The opening 'do' we already found
  let match: RegExpExecArray | null

  while ((match = keywordRegex.exec(blockContent)) !== null) {
    const keyword = match[1].toLowerCase()
    if (keyword === "do") {
      depth++
    } else if (keyword === "end") {
      depth--
      if (depth === 0) {
        // Found the matching 'end', extract everything before it
        return blockContent.substring(0, match.index)
      }
    }
  }

  return null
}

/**
 * Parse field registrations within a queries/mutations block.
 */
function parseRegistrationBlock(
  block: string,
  target: "query" | "mutation",
  registrations: ResolverRegistration[],
  componentNamespace?: string
): void {
  // Split the block into individual field declarations.
  // A new field starts with `field :` at the beginning of a line (after whitespace).
  // We collect each field's multi-line text, then look for resolver: in it.
  const fieldStartRegex = /(?:^|\n)([ \t]*field\s+:(\w+))/g
  const fieldPositions: Array<{ start: number; name: string }> = []

  let match: RegExpExecArray | null
  while ((match = fieldStartRegex.exec(block)) !== null) {
    fieldPositions.push({
      start: match.index + (match[1].startsWith("\n") ? 1 : 0),
      name: match[2],
    })
  }

  logger.log(
    `[NitroGraphQL] Registration: found ${fieldPositions.length} field(s) in ${target} block: ${fieldPositions.map(p => p.name).join(", ")}`
  )

  for (let i = 0; i < fieldPositions.length; i++) {
    const { name: fieldName } = fieldPositions[i]
    const start = fieldPositions[i].start
    const end =
      i + 1 < fieldPositions.length ? fieldPositions[i + 1].start : block.length
    const fieldBlock = block.slice(start, end)

    // Find resolver:, mutation:, or subscription: ::Module::Class within this block
    const resolverMatch = fieldBlock.match(
      /(?:resolver|mutation|subscription):\s*:*([\w][:\w]*)/
    )
    if (!resolverMatch) {
      logger.log(
        `[NitroGraphQL] Registration: field :${fieldName} (${target}) - NO RESOLVER - Block preview: ${fieldBlock.slice(0, 100).replace(/\n/g, "\\n")}`
      )
      continue
    }

    const access = parseAccessLevel(fieldBlock)

    logger.log(
      `[NitroGraphQL] Registration: parsed ${target} :${fieldName} → resolver ${resolverMatch[1]}`
    )

    registrations.push({
      fieldName: snakeToCamel(fieldName),
      resolverClassName: resolverMatch[1],
      target,
      access,
      componentNamespace,
    })
  }
}

// ── Registration File Discovery ────────────────────────────────────────────────

/**
 * Find all component registration files (graphql.rb) under basePath.
 * Pattern: components/COMPONENT/lib/COMPONENT/graphql.rb
 */
export function findRegistrationFiles(basePath: string): string[] {
  const results: string[] = []
  const componentsDir = path.join(basePath, "components")

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(componentsDir, { withFileTypes: true })
  } catch {
    logger.log(`[NitroGraphQL] No components dir found at: ${componentsDir}`)
    return results
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const libDir = path.join(componentsDir, entry.name, "lib")
    try {
      const libEntries = fs.readdirSync(libDir, { withFileTypes: true })
      for (const libEntry of libEntries) {
        if (!libEntry.isDirectory()) {
          continue
        }

        // Pattern 1: lib/<component>/graphql.rb (most common)
        const gqlFile = path.join(libDir, libEntry.name, "graphql.rb")
        try {
          fs.accessSync(gqlFile, fs.constants.R_OK)
          results.push(gqlFile)
        } catch {
          // File doesn't exist, skip
        }

        // Pattern 2: lib/<component>/graphql/*.rb (multi-file registration)
        // e.g. core_models/lib/core_models/graphql/core_models.rb
        const gqlSubdir = path.join(libDir, libEntry.name, "graphql")
        try {
          const gqlSubEntries = fs.readdirSync(gqlSubdir, {
            withFileTypes: true,
          })
          for (const f of gqlSubEntries) {
            if (!f.isFile() || !f.name.endsWith(".rb")) continue
            const candidate = path.join(gqlSubdir, f.name)
            try {
              const content = fs.readFileSync(candidate, "utf-8")
              // Only include files that contain registration blocks
              if (
                content.includes("Schema::Partial") ||
                content.includes("queries do") ||
                content.includes("mutations do")
              ) {
                results.push(candidate)
              }
            } catch {
              // skip unreadable
            }
          }
        } catch {
          // graphql subdir doesn't exist, skip
        }
      }
    } catch {
      // lib dir doesn't exist, skip
    }
  }

  return results
}

// ── Schema Building ────────────────────────────────────────────────────────────

// Custom scalars used by Rails GraphQL
const JSON_SCALAR = new GraphQLScalarType({ name: "Json" })
const DATE_SCALAR = new GraphQLScalarType({ name: "Date" })
const DATETIME_SCALAR = new GraphQLScalarType({ name: "DateTime" })
const UPLOAD_SCALAR = new GraphQLScalarType({ name: "Upload" })
const RAILS_BOOLEAN_SCALAR = new GraphQLScalarType({ name: "RailsBoolean" })
const ACTIVE_STORAGE_UPLOAD_SCALAR = new GraphQLScalarType({
  name: "ActiveStorageUpload",
})

/**
 * Standard Relay PageInfo type — provided automatically by graphql-ruby for all
 * connection fields.  Defined at module level so a single instance is reused.
 */
const PAGE_INFO_TYPE = new GraphQLObjectType({
  name: "PageInfo",
  fields: {
    hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    hasPreviousPage: { type: new GraphQLNonNull(GraphQLBoolean) },
    startCursor: { type: GraphQLString },
    endCursor: { type: GraphQLString },
  },
})

const BUILTIN_SCALARS: Record<string, GraphQLScalarType> = {
  String: GraphQLString,
  Int: GraphQLInt,
  Float: GraphQLFloat,
  Boolean: GraphQLBoolean,
  ID: GraphQLID,
  Json: JSON_SCALAR,
  JSON: JSON_SCALAR,
  Date: DATE_SCALAR,
  DateTime: DATETIME_SCALAR,
  Upload: UPLOAD_SCALAR,
  RailsBoolean: RAILS_BOOLEAN_SCALAR,
  ActiveStorageUpload: ACTIVE_STORAGE_UPLOAD_SCALAR,
}

/**
 * Build a GraphQLSchema from parsed type definitions, resolvers, and registrations.
 */
export function buildGraphQLSchema(
  typeDefs: GraphQLTypeDefinition[],
  resolvers: ResolverDefinition[] = [],
  registrations: ResolverRegistration[] = []
): GraphQLSchema {
  // Collect all types by name for cross-referencing
  const typeMap = new Map<string, GraphQLTypeDefinition>()
  // Alias map: derived class name → actual graphql name
  // Handles resolver references like AgentStatsType → WarrantyAgentStats
  const aliasMap = new Map<string, string>()
  // Map from GraphQL type name to the Ruby file where it's defined
  const typeFileMap = new Map<string, string>()

  for (const td of typeDefs) {
    typeMap.set(td.name, td)
    typeFileMap.set(td.name, td.fileName)
    // If the graphql_name differs from the class-derived name, add an alias
    if (td.classBasedName !== td.name) {
      aliasMap.set(td.classBasedName, td.name)
    }
  }

  // Ruby path map: full Ruby class path → graphql_name.
  // Enables unambiguous resolution when multiple types share the same
  // classBasedName but live in different namespaces (e.g.
  // Spaces::Graphql::CalendarEventType (graphql_name "CalendarEvent") vs
  // BrandHeadlines::Graphql::CalendarEventType (graphql_name "BrandHeadlinesCalendarEvent")).
  const rubyPathMap = new Map<string, string>()
  for (const td of typeDefs) {
    if (td.rubyPath) {
      rubyPathMap.set(td.rubyPath, td.name)
    }
  }

  // Build resolver lookup by full class name
  const resolverMap = new Map<string, ResolverDefinition>()
  for (const r of resolvers) {
    resolverMap.set(r.className, r)
  }

  // Lazy type registry to handle circular references
  const registry = new Map<string, GraphQLOutputType | GraphQLInputType>()

  // Cache for permissive fallback object types (one instance per type name)
  const fallbackTypeCache = new Map<string, GraphQLObjectType>()

  // Register built-in scalars
  for (const [name, scalar] of Object.entries(BUILTIN_SCALARS)) {
    registry.set(name, scalar)
  }

  // Register the built-in Relay PageInfo type only if no Ruby file has already
  // defined a type with that name (to avoid conflicts with custom PageInfo types).
  if (!registry.has("PageInfo")) {
    registry.set("PageInfo", PAGE_INFO_TYPE)
  }

  // Cache for synthetic connection types so each base type gets one instance.
  const connectionTypeCache = new Map<string, GraphQLObjectType>()

  /**
   * Get or build a Relay Connection type for the given base type name.
   * graphql-ruby wraps all list-returning fields in a Connection type automatically
   * (via `connection_type_class NitroGraphql::Types::BaseConnection`), giving them:
   *   - `nodes: [BaseType]`
   *   - `edges: [BaseTypeEdge]` (each with `node` and `cursor`)
   *   - `pageInfo: PageInfo!`
   *   - `totalEntries: Int!`
   * And the field itself gets implicit `first`, `last`, `before`, `after` args.
   */
  function getOrBuildConnectionType(baseTypeName: string): GraphQLObjectType {
    if (connectionTypeCache.has(baseTypeName)) {
      return connectionTypeCache.get(baseTypeName)!
    }

    // Resolve the base type; fall back to a permissive object if unknown.
    const resolved = getOrBuildType(baseTypeName) as GraphQLOutputType | null
    const fallbackName = `_Unknown_${baseTypeName.replace(/\W/g, "_")}`
    const baseType: GraphQLOutputType =
      resolved ??
      (fallbackTypeCache.get(fallbackName) ||
        (() => {
          const fb = new GraphQLObjectType({
            name: fallbackName,
            fields: () => ({ placeholder: { type: GraphQLString } }),
          })
          fallbackTypeCache.set(fallbackName, fb)
          return fb
        })())

    // Use the resolved type's canonical name for naming the Connection/Edge types
    // so that aliases are reflected (e.g. "AgentStats" → "WarrantyAgentStats")
    const canonicalName = (baseType as any).name ?? baseTypeName

    // Recheck cache using canonical name to avoid creating duplicates
    if (connectionTypeCache.has(canonicalName)) {
      connectionTypeCache.set(
        baseTypeName,
        connectionTypeCache.get(canonicalName)!
      )
      return connectionTypeCache.get(canonicalName)!
    }

    const pageInfoType = (registry.get("PageInfo") ??
      PAGE_INFO_TYPE) as GraphQLObjectType

    const edgeType = new GraphQLObjectType({
      name: `${canonicalName}Edge`,
      fields: {
        node: { type: baseType },
        cursor: { type: new GraphQLNonNull(GraphQLString) },
      },
    })

    const connectionType = new GraphQLObjectType({
      name: `${canonicalName}Connection`,
      fields: {
        nodes: { type: new GraphQLList(baseType) },
        edges: { type: new GraphQLList(edgeType) },
        pageInfo: { type: new GraphQLNonNull(pageInfoType) },
        totalEntries: { type: new GraphQLNonNull(GraphQLInt) },
      },
    })

    connectionTypeCache.set(baseTypeName, connectionType)
    connectionTypeCache.set(canonicalName, connectionType)
    return connectionType
  }

  function resolveOutputType(
    typeName: string,
    isList: boolean,
    listDepth: number = 0,
    nullable: boolean
  ): GraphQLOutputType {
    let baseType = getOrBuildType(typeName) as GraphQLOutputType
    if (!baseType) {
      // Type not parsed — use a permissive object type (with a placeholder field)
      // rather than GraphQLString so that selection sets on the field don't
      // produce false "type has no subfields" errors.
      // Cache by type name so the same instance is reused across all fields.
      const fallbackName = `_Unknown_${typeName.replace(/\W/g, "_")}`
      if (!fallbackTypeCache.has(fallbackName)) {
        fallbackTypeCache.set(
          fallbackName,
          new GraphQLObjectType({
            name: fallbackName,
            fields: () => ({
              placeholder: { type: GraphQLString },
            }),
          })
        )
        logger.warn(
          `[NitroGraphQL] Unknown output type '${typeName}', using permissive fallback`
        )
      }
      baseType = fallbackTypeCache.get(fallbackName)!
    }

    // If the resolved type is actually an input type it cannot be used as an
    // output field type.  Fall back to the permissive object type and warn.
    if (baseType instanceof GraphQLInputObjectType) {
      const fallbackName = `_Unknown_${typeName.replace(/\W/g, "_")}`
      if (!fallbackTypeCache.has(fallbackName)) {
        fallbackTypeCache.set(
          fallbackName,
          new GraphQLObjectType({
            name: fallbackName,
            fields: () => ({ placeholder: { type: GraphQLString } }),
          })
        )
      }
      logger.warn(
        `[NitroGraphQL] Field type '${typeName}' is an Input type and cannot be used as an output field type; using permissive fallback`
      )
      baseType = fallbackTypeCache.get(fallbackName)!
    }

    let type: GraphQLOutputType = baseType

    // Build nested list structure: [[Type]] → List(List(NonNull(Type)))
    if (listDepth > 0) {
      for (let i = 0; i < listDepth; i++) {
        type = new GraphQLList(new GraphQLNonNull(type))
      }
    }

    if (!nullable) {
      type = new GraphQLNonNull(type)
    }
    return type
  }

  function resolveInputType(
    typeName: string,
    isList: boolean,
    listDepth: number = 0,
    nullable: boolean
  ): GraphQLInputType {
    let baseType = getOrBuildType(typeName) as GraphQLInputType
    if (!baseType) {
      baseType = GraphQLString
    }

    let type: GraphQLInputType = baseType

    // Build nested list structure: [[Type]] → List(List(NonNull(Type)))
    if (listDepth > 0) {
      for (let i = 0; i < listDepth; i++) {
        type = new GraphQLList(new GraphQLNonNull(type))
      }
    }

    if (!nullable) {
      type = new GraphQLNonNull(type)
    }
    return type
  }

  function getOrBuildType(
    name: string
  ): GraphQLOutputType | GraphQLInputType | null {
    // Fast path: already built.
    if (registry.has(name)) return registry.get(name)!

    // If `name` is itself a canonical graphql_name (exists directly in typeMap)
    // we must use it as-is.  Do NOT redirect through the aliasMap in this case:
    // another class can share the same classBasedName with a different graphql_name
    // (e.g. ReviewEmployee has classBasedName "Employee" → aliasMap["Employee"] =
    // "ReviewEmployee"), and that must not shadow a legitimate type whose
    // graphql_name IS "Employee".
    if (typeMap.has(name)) {
      // Build directly — do not alias-redirect.
      const def = typeMap.get(name)!
      switch (def.kind) {
        case "object":
          return buildObjectType(def)
        case "interface":
          return buildInterfaceType(def)
        case "input":
          return buildInputType(def)
        case "enum":
          return buildEnumType(def)
        case "scalar":
          return buildScalarType(def)
        case "union":
          return buildUnionType(def)
        default:
          return null
      }
    }

    // `name` is not a direct graphql_name — it may be a classBasedName that
    // aliases to the real graphql_name (e.g. "AgentStats" → "WarrantyAgentStats").
    const aliased = aliasMap.get(name)
    if (aliased) {
      if (registry.has(aliased)) return registry.get(aliased)!
      const def = typeMap.get(aliased)
      if (def) {
        switch (def.kind) {
          case "object":
            return buildObjectType(def)
          case "interface":
            return buildInterfaceType(def)
          case "input":
            return buildInputType(def)
          case "enum":
            return buildEnumType(def)
          case "scalar":
            return buildScalarType(def)
          case "union":
            return buildUnionType(def)
          default:
            return null
        }
      }
    }

    return null
  }

  /**
   * Recursively collect fields from the ancestor chain (grandparent → parent),
   * so that a child type automatically inherits all fields defined on parent types.
   */
  function collectInheritedFields(
    def: GraphQLTypeDefinition,
    visited = new Set<string>()
  ): FieldDefinition[] {
    if (visited.has(def.name)) return []
    visited.add(def.name)

    const parts = def.parentClass.split("::")
    const lastPart = parts[parts.length - 1]
    if (!lastPart.endsWith("Type")) return []

    const parentDerivedName = deriveTypeName(lastPart)
    // Only redirect through the aliasMap when the derived name is NOT itself
    // a canonical graphql_name.  If it IS (e.g. parent graphql_name "Employee"
    // exists in typeMap), using the alias would wrongly redirect to another
    // type that happens to share the classBasedName.
    const parentActualName = typeMap.has(parentDerivedName)
      ? parentDerivedName
      : (aliasMap.get(parentDerivedName) ?? parentDerivedName)
    const parentDef =
      typeMap.get(parentActualName) ?? typeMap.get(parentDerivedName)
    if (!parentDef) return []

    // Grandparent fields first, then parent's own fields (more-derived wins)
    return [...collectInheritedFields(parentDef, visited), ...parentDef.fields]
  }

  /**
   * Recursively collect interfaces from the ancestor chain (grandparent → parent),
   * so that a child type automatically implements all interfaces from parent types.
   * Returns unique interface names (deduplicated).
   */
  function collectInheritedInterfaces(
    def: GraphQLTypeDefinition,
    visited = new Set<string>()
  ): string[] {
    if (visited.has(def.name)) return []
    visited.add(def.name)

    const parts = def.parentClass.split("::")
    const lastPart = parts[parts.length - 1]
    if (!lastPart.endsWith("Type")) return []

    const parentDerivedName = deriveTypeName(lastPart)
    const parentActualName = typeMap.has(parentDerivedName)
      ? parentDerivedName
      : (aliasMap.get(parentDerivedName) ?? parentDerivedName)
    const parentDef =
      typeMap.get(parentActualName) ?? typeMap.get(parentDerivedName)
    if (!parentDef) return []

    // Grandparent interfaces first, then parent's own interfaces
    const inherited = collectInheritedInterfaces(parentDef, visited)
    // Deduplicate by combining sets
    const allInterfaces = new Set([...inherited, ...parentDef.implements])
    return Array.from(allInterfaces)
  }

  /**
   * Build a GraphQL field config for a single FieldDefinition, handling:
   *
   * 1. `field :name, resolver: Class` — looks up the resolver in resolverMap,
   *    uses its return type (with rubyPathMap disambiguation) and argument list.
   * 2. Namespace-disambiguated field types — when the field was declared with
   *    a fully-qualified Ruby path (typeRubyPath), resolves it through rubyPathMap
   *    to get the correct graphql_name instead of normalizeRubyType's short form.
   * 3. Normal fields — straightforward type + nullable + fieldArgs resolution.
   */
  function buildFieldConfig(field: FieldDefinition): {
    type: GraphQLOutputType
    description?: string
    args?: GraphQLFieldConfigArgumentMap
  } {
    // resolver: Class — look up the resolver and use its return type / arguments
    if (field.resolverClassName) {
      const resolver = findResolver(field.resolverClassName)
      if (resolver) {
        const resolvedReturnTypeName =
          resolver.returnTypeRubyPath &&
          rubyPathMap.has(resolver.returnTypeRubyPath)
            ? rubyPathMap.get(resolver.returnTypeRubyPath)!
            : resolver.returnType
        let fieldType: GraphQLOutputType
        if (resolver.isConnectionType) {
          const connType = getOrBuildConnectionType(resolvedReturnTypeName)
          fieldType = resolver.returnTypeNullable
            ? connType
            : new GraphQLNonNull(connType)
        } else {
          fieldType = resolveOutputType(
            resolvedReturnTypeName,
            resolver.returnTypeIsList,
            resolver.returnTypeListDepth,
            resolver.returnTypeNullable
          )
        }
        const result: any = { type: fieldType }
        if (resolver.description) result.description = resolver.description
        const resolverArgs = buildFieldArgs(resolver.arguments)
        if (Object.keys(resolverArgs).length > 0) result.args = resolverArgs
        return result
      }
      // Resolver class not found — use permissive fallback object type so
      // selection sets on the field don't produce false "has no subfields" errors.
      const fallbackName = `_Unknown_${field.resolverClassName.replace(/\W/g, "_")}`
      if (!fallbackTypeCache.has(fallbackName)) {
        fallbackTypeCache.set(
          fallbackName,
          new GraphQLObjectType({
            name: fallbackName,
            fields: { __typename: { type: GraphQLString } },
          })
        )
      }
      return { type: fallbackTypeCache.get(fallbackName)! }
    }

    // Use rubyPathMap when the field type was declared with a fully-qualified path
    const resolvedTypeName =
      field.typeRubyPath && rubyPathMap.has(field.typeRubyPath)
        ? rubyPathMap.get(field.typeRubyPath)!
        : field.type

    // Handle .connection_type for regular fields (e.g., field :employees, MyType.connection_type)
    let fieldType: GraphQLOutputType
    let fieldArgs: GraphQLFieldConfigArgumentMap = {}

    if (field.isConnectionType) {
      // Wrap in connection type and add Relay pagination arguments
      const connectionType = getOrBuildConnectionType(resolvedTypeName)
      fieldType = field.nullable
        ? connectionType
        : new GraphQLNonNull(connectionType)

      // Add standard Relay connection arguments
      const relayArgs: GraphQLFieldConfigArgumentMap = {
        first: { type: GraphQLInt },
        last: { type: GraphQLInt },
        before: { type: GraphQLString },
        after: { type: GraphQLString },
      }
      fieldArgs = relayArgs
    } else {
      fieldType = resolveOutputType(
        resolvedTypeName,
        field.isList,
        field.listDepth,
        !field.nullable
      )
    }

    const fc: any = { type: fieldType }
    if (field.description) fc.description = field.description
    if (field.fieldArgs && field.fieldArgs.length > 0) {
      const inlineArgs = buildFieldArgs(field.fieldArgs)
      fieldArgs = { ...fieldArgs, ...inlineArgs }
    }
    if (Object.keys(fieldArgs).length > 0) {
      fc.args = fieldArgs
    }
    return fc
  }

  function buildObjectType(def: GraphQLTypeDefinition): GraphQLObjectType {
    const obj = new GraphQLObjectType({
      name: def.name,
      description: def.description,
      fields: () => {
        const fieldConfig: GraphQLFieldConfigMap<any, any> = {}
        // Inherited fields from parent chain (applied first so child fields override)
        for (const field of collectInheritedFields(def)) {
          fieldConfig[field.name] = buildFieldConfig(field)
        }
        // Own fields (override any inherited with same name)
        for (const field of def.fields) {
          fieldConfig[field.name] = buildFieldConfig(field)
        }
        // Merge any interface fields not already provided, so that GraphQL
        // interface-conformance validation passes even when the Ruby code relies
        // on inheritance to satisfy the interface contract.
        // Include both directly-declared and inherited interfaces
        const allInterfaceNames = new Set([
          ...def.implements,
          ...collectInheritedInterfaces(def),
        ])
        for (const ifaceName of allInterfaceNames) {
          const ifaceActualName = aliasMap.get(ifaceName) ?? ifaceName
          const ifaceDef =
            typeMap.get(ifaceActualName) ?? typeMap.get(ifaceName)
          if (ifaceDef) {
            const ifaceFields = [
              ...collectInheritedFields(ifaceDef),
              ...ifaceDef.fields,
            ]
            for (const field of ifaceFields) {
              const ifaceFieldType = resolveOutputType(
                field.type,
                field.isList,
                field.listDepth,
                !field.nullable
              )
              if (field.name in fieldConfig) {
                // Field exists on the implementing type — check for type mismatch.
                // The interface defines the contract so we use its type, but warn.
                const existing = fieldConfig[field.name].type
                if (existing.toString() !== ifaceFieldType.toString()) {
                  logger.warn(
                    `[NitroGraphQL] Type mismatch: ${def.name}.${field.name} declared as ${existing} but interface requires ${ifaceFieldType}; using interface type`
                  )
                  const fc: any = { type: ifaceFieldType }
                  if (field.description) {
                    fc.description = field.description
                  }
                  // Preserve field arguments from interface
                  if (field.fieldArgs && field.fieldArgs.length > 0) {
                    fc.args = buildFieldArgs(field.fieldArgs)
                  }
                  fieldConfig[field.name] = fc
                }
              } else {
                const fc: any = { type: ifaceFieldType }
                if (field.description) {
                  fc.description = field.description
                }
                // Preserve field arguments from interface
                if (field.fieldArgs && field.fieldArgs.length > 0) {
                  fc.args = buildFieldArgs(field.fieldArgs)
                }
                fieldConfig[field.name] = fc
              }
            }
          }
        }
        // If no fields, add a dummy placeholder field to pass validation
        if (Object.keys(fieldConfig).length === 0) {
          fieldConfig["placeholder"] = {
            type: GraphQLString,
            deprecationReason: "Placeholder for empty type",
          }
        }
        return fieldConfig
      },

      interfaces: () => {
        // Collect both directly-declared and inherited interfaces
        const allInterfaces = new Set([
          ...def.implements,
          ...collectInheritedInterfaces(def),
        ])
        return Array.from(allInterfaces)
          .map(name => {
            const iface = getOrBuildType(name)
            return iface instanceof GraphQLInterfaceType ? iface : null
          })
          .filter((i): i is GraphQLInterfaceType => i !== null)
      },
    })
    registry.set(def.name, obj)
    return obj
  }

  function buildInterfaceType(
    def: GraphQLTypeDefinition
  ): GraphQLInterfaceType {
    const iface = new GraphQLInterfaceType({
      name: def.name,
      description: def.description,
      fields: () => {
        const fieldConfig: GraphQLFieldConfigMap<any, any> = {}
        for (const field of def.fields) {
          fieldConfig[field.name] = buildFieldConfig(field)
        }
        if (Object.keys(fieldConfig).length === 0) {
          fieldConfig["placeholder"] = {
            type: GraphQLString,
            deprecationReason: "Placeholder for empty interface",
          }
        }
        return fieldConfig
      },
    })
    registry.set(def.name, iface)
    return iface
  }

  function buildInputType(def: GraphQLTypeDefinition): GraphQLInputObjectType {
    const input = new GraphQLInputObjectType({
      name: def.name,
      description: def.description,
      fields: () => {
        const fieldConfig: GraphQLInputFieldConfigMap = {}
        // Inherited fields from parent input type chain
        for (const field of collectInheritedFields(def)) {
          const fc: any = {
            type: resolveInputType(
              field.type,
              field.isList,
              field.listDepth,
              !field.nullable
            ),
          }
          if (field.description) {
            fc.description = field.description
          }
          fieldConfig[field.name] = fc
        }
        // Own fields (override any inherited)
        for (const field of def.fields) {
          const fc: any = {
            type: resolveInputType(
              field.type,
              field.isList,
              field.listDepth,
              !field.nullable
            ),
          }
          if (field.description) {
            fc.description = field.description
          }
          fieldConfig[field.name] = fc
        }
        if (Object.keys(fieldConfig).length === 0) {
          fieldConfig["placeholder"] = {
            type: GraphQLString,
          }
        }
        return fieldConfig
      },
    })
    registry.set(def.name, input)
    return input
  }

  function buildEnumType(def: GraphQLTypeDefinition): GraphQLEnumType {
    const values: GraphQLEnumValueConfigMap = {}
    for (const val of def.enumValues) {
      values[val] = { value: val }
    }
    // Ensure at least one value
    if (Object.keys(values).length === 0) {
      values["UNKNOWN"] = { value: "UNKNOWN" }
    }
    const enumType = new GraphQLEnumType({
      name: def.name,
      description: def.description,
      values,
    })
    registry.set(def.name, enumType)
    return enumType
  }

  function buildScalarType(def: GraphQLTypeDefinition): GraphQLScalarType {
    const scalar = new GraphQLScalarType({
      name: def.name,
      description: def.description,
    })
    registry.set(def.name, scalar)
    return scalar
  }

  function buildUnionType(def: GraphQLTypeDefinition): GraphQLUnionType {
    // Register a placeholder immediately to break any circular references
    // before the thunk resolves the member types.
    const union = new GraphQLUnionType({
      name: def.name,
      description: def.description,
      types: () => {
        const memberTypes: GraphQLObjectType[] = []
        const shortNames = def.possibleTypes ?? []
        const fullPaths = def.possibleTypesRubyPaths ?? []

        // Try to resolve each member type using both short name and full path
        for (let i = 0; i < shortNames.length; i++) {
          const shortName = shortNames[i]
          const fullPath = fullPaths[i]

          // First try resolving via rubyPathMap using the full path if available
          let typeName = shortName
          if (fullPath && rubyPathMap.has(fullPath)) {
            typeName = rubyPathMap.get(fullPath)!
          }

          const t = getOrBuildType(typeName)
          if (t instanceof GraphQLObjectType) {
            memberTypes.push(t)
          } else if (!t) {
            // Log warning if a promised type couldn't be resolved
            logger.warn(
              `[NitroGraphQL] Union ${def.name}: couldn't resolve member type '${shortName}' (full path: ${fullPath})`
            )
          }
        }

        if (memberTypes.length === 0) {
          // Placeholder so GraphQL doesn't reject an empty union
          logger.warn(
            `[NitroGraphQL] Union ${def.name}: no member types resolved, using placeholder`
          )
          memberTypes.push(
            new GraphQLObjectType({
              name: `_${def.name}Member`,
              fields: { placeholder: { type: GraphQLString } },
            })
          )
        }
        return memberTypes
      },
    })
    registry.set(def.name, union)
    return union
  }

  /**
   * Build field arguments from a resolver's argument definitions.
   */
  function buildFieldArgs(
    argDefs: ArgumentDefinition[]
  ): GraphQLFieldConfigArgumentMap {
    const args: GraphQLFieldConfigArgumentMap = {}
    for (const argDef of argDefs) {
      // If the argument was declared with a fully-qualified Ruby path, use the
      // rubyPathMap to resolve the exact graphql_name (avoids collisions when
      // two namespaces define a class with the same short name).
      const typeName =
        argDef.typeRubyPath && rubyPathMap.has(argDef.typeRubyPath)
          ? rubyPathMap.get(argDef.typeRubyPath)!
          : argDef.type
      let argType = resolveInputType(
        typeName,
        argDef.isList,
        argDef.listDepth,
        !argDef.required
      )
      if (argDef.required) {
        argType =
          argType instanceof GraphQLNonNull
            ? argType
            : new GraphQLNonNull(argType)
      }
      args[argDef.name] = { type: argType }
    }
    return args
  }

  /**
   * Match a registration's resolverClassName to a parsed resolver.
   * The registration may use the full path (::Warranty::Graphql::AgentStatsQuery)
   * while the resolver stores (Warranty::Graphql::AgentStatsQuery).
   *
   * For unqualified resolver names (e.g., "TeamsQuery"), prefer the same namespace
   * as the registration's component to avoid collisions when multiple components
   * define resolvers with the same class name.
   *
   * We intentionally do NOT fall back to class-name-only matching: two
   * namespaces may define resolvers with the same leaf class name but
   * different arguments (e.g. Warranty::PendingProposedItemChangesQuery and
   * Projects::PendingProposedItemChangesQuery).  A wrong match would attach
   * the wrong required arguments to the registered field.
   */
  function findResolver(
    resolverClassName: string,
    componentNamespace?: string
  ): ResolverDefinition | undefined {
    // Strip leading :: for matching
    const normalized = resolverClassName.replace(/^::/, "")

    // If resolver name is unqualified (no ::) and component namespace is provided,
    // first try to find resolver in the same component's Graphql namespace
    if (componentNamespace && !normalized.includes("::")) {
      const sameNamespaceKey = `${componentNamespace}::Graphql::${normalized}`
      if (resolverMap.has(sameNamespaceKey)) {
        return resolverMap.get(sameNamespaceKey)
      }
    }

    // Fall back to existing matching logic
    for (const [key, resolver] of resolverMap) {
      if (
        key === normalized ||
        key.endsWith("::" + normalized.split("::").pop()!)
      ) {
        // Only accept an endsWith match when the registration path is a
        // suffix of the resolver's stored full path, preventing a partial
        // class-name collision between different namespaces.
        const regSegments = normalized.split("::")
        const resolverSegments = key.split("::")
        // Ensure the matching suffix covers at least the namespace delimiter
        const suffixMatches =
          key === normalized ||
          (resolverSegments.length >= regSegments.length &&
            resolverSegments
              .slice(resolverSegments.length - regSegments.length)
              .join("::") === normalized)
        if (suffixMatches) {
          return resolver
        }
      }
    }
    return undefined
  }

  // Pre-build all types so they end up in the registry
  for (const def of typeDefs) {
    if (!registry.has(def.name)) {
      getOrBuildType(def.name)
    }
  }

  // Build root query fields from registrations
  const queryFields: GraphQLFieldConfigMap<any, any> = {}
  const mutationFields: GraphQLFieldConfigMap<any, any> = {}

  for (const reg of registrations) {
    const resolver = findResolver(reg.resolverClassName, reg.componentNamespace)
    if (!resolver) {
      logger.log(
        `[NitroGraphQL]   ⚠️  UNRESOLVED ${reg.target} '${reg.fieldName}': resolver class '${reg.resolverClassName}' not found\n` +
          `       📍 Expected to find a class definition matching: ${reg.resolverClassName}\n` +
          `       ✓ Fix: Create a resolver file in graphql/ directory matching the class name\n` +
          `       💡 Example: class ${reg.resolverClassName.split("::").pop()} < NitroGraphql::BaseQuery\n` +
          `       💡 Common causes: typo in class name, file not in graphql/ directory, inheritance from wrong base class`
      )
      // Registration found but resolver not parsed — add a permissive placeholder
      // field to avoid false-positive "Cannot query field" errors. The field
      // accepts any arguments and returns String, so structural validation still
      // happens at the selection-set level for types we DID parse.
      const fieldConfig: any = { type: GraphQLString }
      if (reg.target === "query") {
        queryFields[reg.fieldName] = fieldConfig
      } else {
        mutationFields[reg.fieldName] = fieldConfig
      }
      continue
    }

    logger.log(
      `[NitroGraphQL]   RESOLVED ${reg.target} '${reg.fieldName}': ${reg.resolverClassName}`
    )

    // graphql-ruby automatically wraps list-returning fields in a Relay
    // Connection type (nodes/edges/pageInfo/totalEntries) and adds implicit
    // first/last/before/after arguments.  Mirror that here.
    // Only apply Connection wrapping when the resolver explicitly uses `.connection_type`
    // syntax — plain list returns (`[Type]`) render as ordinary GraphQL lists.
    let returnType: GraphQLOutputType
    let args = buildFieldArgs(resolver.arguments)

    // If the resolver declared its return type with a fully-qualified Ruby path,
    // resolve it through rubyPathMap to get the exact graphql_name (avoids
    // collisions when two namespaces have a class with the same short name).
    const resolvedReturnTypeName =
      resolver.returnTypeRubyPath &&
      rubyPathMap.has(resolver.returnTypeRubyPath)
        ? rubyPathMap.get(resolver.returnTypeRubyPath)!
        : resolver.returnType

    if (resolver.isConnectionType) {
      const connectionType = getOrBuildConnectionType(resolvedReturnTypeName)
      returnType = resolver.returnTypeNullable
        ? connectionType
        : new GraphQLNonNull(connectionType)

      // Add standard Relay connection arguments ahead of anything the resolver
      // declared explicitly (resolver wins on collision).
      const relayArgs: GraphQLFieldConfigArgumentMap = {
        first: { type: GraphQLInt },
        last: { type: GraphQLInt },
        before: { type: GraphQLString },
        after: { type: GraphQLString },
      }
      args = { ...relayArgs, ...args }
    } else {
      returnType = resolveOutputType(
        resolvedReturnTypeName,
        resolver.returnTypeIsList,
        resolver.returnTypeListDepth,
        resolver.returnTypeNullable
      )
    }

    const fieldConfig: any = { type: returnType }
    if (resolver.description) {
      fieldConfig.description = resolver.description
    }
    if (Object.keys(args).length > 0) {
      fieldConfig.args = args
    }

    // Store resolver metadata in extensions so the hover provider can surface it
    fieldConfig.extensions = {
      resolverClass: resolver.className,
      resolverFile: resolver.fileName,
      access: reg.access ?? [],
    }

    if (reg.target === "query") {
      queryFields[reg.fieldName] = fieldConfig
    } else {
      mutationFields[reg.fieldName] = fieldConfig
    }
  }

  // Also check if there's a manually-defined Query/Mutations type in the typeDefs
  // (for backward compatibility with test fixtures)
  const queriesDef = typeDefs.find(
    t => t.name === "Queries" || t.name === "Query" || t.name === "QueryType"
  )
  const mutationsDef = typeDefs.find(
    t =>
      t.name === "Mutations" ||
      t.name === "Mutation" ||
      t.name === "MutationType"
  )

  if (queriesDef) {
    const existingQueryType = registry.get(queriesDef.name) as GraphQLObjectType
    if (existingQueryType) {
      const fields = existingQueryType.getFields()
      for (const [name, field] of Object.entries(fields)) {
        if (!queryFields[name]) {
          const fc: any = { type: field.type }
          if (field.description) {
            fc.description = field.description
          }
          queryFields[name] = fc
        }
      }
    }
  }

  if (mutationsDef) {
    const existingMutationType = registry.get(
      mutationsDef.name
    ) as GraphQLObjectType
    if (existingMutationType) {
      const fields = existingMutationType.getFields()
      for (const [name, field] of Object.entries(fields)) {
        if (!mutationFields[name]) {
          const fc: any = { type: field.type }
          if (field.description) {
            fc.description = field.description
          }
          mutationFields[name] = fc
        }
      }
    }
  }

  // Build the root Query type
  const hasQueryFields = Object.keys(queryFields).length > 0
  if (!hasQueryFields) {
    throw new Error(
      "[NitroGraphQL] No Query/Queries root type found in schema files"
    )
  }

  // Remove legacy Query/Mutations types from registry to avoid duplicate names
  if (queriesDef) {
    registry.delete(queriesDef.name)
  }
  if (mutationsDef) {
    registry.delete(mutationsDef.name)
  }

  const queryType = new GraphQLObjectType({
    name: "Queries",
    fields: () => queryFields,
  })

  // Build the root Mutation type (optional)
  const hasMutationFields = Object.keys(mutationFields).length > 0
  const mutationType = hasMutationFields
    ? new GraphQLObjectType({
        name: "Mutations",
        fields: () => mutationFields,
      })
    : undefined

  // Collect all types for the schema
  const types = Array.from(registry.values()).filter(
    (
      t
    ): t is
      | GraphQLObjectType
      | GraphQLInterfaceType
      | GraphQLUnionType
      | GraphQLEnumType
      | GraphQLInputObjectType
      | GraphQLScalarType =>
      t instanceof GraphQLObjectType ||
      t instanceof GraphQLInterfaceType ||
      t instanceof GraphQLUnionType ||
      t instanceof GraphQLEnumType ||
      t instanceof GraphQLInputObjectType ||
      t instanceof GraphQLScalarType
  )

  return new GraphQLSchema({
    query: queryType,
    mutation: mutationType,
    types,
    extensions: {
      // Map from GraphQL type names to their source file paths for hover tooltips
      typeFileMap: Object.fromEntries(typeFileMap),
    },
  })
}

/**
 * Validate that a schema is well-formed.
 * Returns errors array with enhanced messaging — empty means valid.
 */
export function validateSchemaIntegrity(schema: GraphQLSchema): string[] {
  const errors = validateSchema(schema)
  return errors.map(e => enhanceValidationErrorMessage(e.message))
}

/**
 * Enhance GraphQL validation error messages with more context and actionability.
 * Detects common patterns and provides specific guidance for fixing them.
 * Exported for use in the query validator as well.
 */
export function enhanceValidationErrorMessage(message: string): string {
  // Pattern: Union field type conflicts
  // "Fields "fieldName" conflict because they return conflicting types "Type1" and "Type2"."
  const unionConflictMatch = message.match(
    /Fields "([^"]+)" conflict because they return conflicting types "([^"]+)" and "([^"]+)"/
  )
  if (unionConflictMatch) {
    const fieldName = unionConflictMatch[1]
    const type1 = unionConflictMatch[2]
    const type2 = unionConflictMatch[3]
    return (
      `❌ Union member field conflict: "${fieldName}"\n` +
      `   Found type "${type1}" in one union member, but "${type2}" in another.\n` +
      `   ✓ Fix: Make the field types consistent across all union members.\n` +
      `   ✓ Both should be "${type1}" or both should be "${type2}".\n` +
      `   📍 Check: Look for field :${fieldName.replace(/([A-Z])/g, "_$1").toLowerCase()} declarations in union member types.\n` +
      `   💡 If "${fieldName}" is required everywhere, use "null: false" on all versions.\n` +
      `   💡 If "${fieldName}" is optional everywhere, remove "null: false" from all versions.`
    )
  }

  // Pattern: Type does not exist
  // "@Foo cannot represent value" or "Cannot find type @Foo"
  const unknownTypeMatch = message.match(/Cannot find type ([a-zA-Z_]\w*)/i)
  if (unknownTypeMatch) {
    const typeName = unknownTypeMatch[1]
    return (
      `❌ Missing type: "${typeName}"\n` +
      `   A field or resolver references a type that was not found in the schema.\n` +
      `   ✓ Fix: Either create a type definition for "${typeName}" or fix the reference.\n` +
      `   📍 Search your graphql/ directories for a class named "${typeName}Type" or "${typeName}".\n` +
      `   💡 Ensure the file is in a graphql/ subdirectory so it gets discovered.\n` +
      `   💡 Check spelling: is it "${typeName}" or did you mean something similar?`
    )
  }

  // Pattern: Circular reference warnings
  if (message.includes("Circular reference") || message.includes("circular")) {
    return (
      `⚠️  Circular type reference detected\n` +
      `   ${message}\n` +
      `   ✓ Fix: Use lazy type resolution or nullable fields to break the cycle.\n` +
      `   💡 Make sure at least one field in the cycle is nullable (optional).`
    )
  }

  // Pattern: Input object invalid
  if (message.includes("Input Object type") && message.includes("must have")) {
    return (
      `❌ Invalid input type definition\n` +
      `   ${message}\n` +
      `   ✓ Fix: Input object types can only contain scalar fields, other input types, or lists/non-nulls of these.\n` +
      `   💡 You cannot use BaseObject types (ObjectType) inside an input type.\n` +
      `   💡 Create a separate InputType with InputField definitions instead.`
    )
  }

  // Pattern: Missing required argument
  if (
    message.includes("Argument") &&
    message.includes("type must be") &&
    !message.includes("specified inline")
  ) {
    return (
      `❌ Invalid query/mutation argument\n` +
      `   ${message}\n` +
      `   ✓ Fix: Check your argument type definitions in the resolver.\n` +
      `   💡 Arguments should use: argument :name, Type or argument :name, [Type]\n` +
      `   💡 Ensure the type exists and is properly named.`
    )
  }

  // Pattern: Field return type issues
  if (message.includes("Field") && message.includes("argument")) {
    return (
      `❌ Field or argument definition error\n` +
      `   ${message}\n` +
      `   ✓ Fix: Check the field definition in your type class.\n` +
      `   📍 Look for: field :name, Type or argument :name, Type\n` +
      `   💡 Ensure all types referenced are defined in your schema.`
    )
  }

  // Fallback: Just return the message with a hint to check the GraphQL schema spec
  return (
    `${message}\n` +
    `   ✓ See: https://spec.graphql.org/June2018/#sec-Schema\n` +
    `   💡 Common fixes: ensure all types exist, field types are consistent, required fields match across union members.`
  )
}

// ── Full Build Pipeline ────────────────────────────────────────────────────────

export interface SchemaBuildResult {
  schema: GraphQLSchema
  typeCount: number
  resolverCount: number
  registrationCount: number
  errors: string[]
  skippedFiles: string[]
  memoryUsedBytes?: number
}

/**
 * Full pipeline: discover → load → parse (types + resolvers + registrations) → build → validate.
 */
export function buildSchemaFromDirectory(basePath: string): SchemaBuildResult {
  logger.log(`[NitroGraphQL] Discovering GraphQL files in: ${basePath}`)

  const directories = findGraphQLDirectories(basePath)
  logger.log(`[NitroGraphQL] Found ${directories.length} graphql directories`)

  if (directories.length === 0) {
    throw new Error(
      `[NitroGraphQL] No graphql directories found under ${basePath}`
    )
  }

  const files = loadGraphQLTypeFiles(directories)
  logger.log(`[NitroGraphQL] Loaded ${files.size} Ruby files`)
  logger.log(
    `[NitroGraphQL] Ruby files found: ${[...files.keys()].map(f => f.split("/").slice(-3).join("/")).join(", ")}`
  )

  // Build a registry of mixin modules that contribute arguments (e.g. PaginationArguments).
  // Mixin files (e.g. NitroGraphql::PaginationArguments) typically live in lib/ directories
  // that are NOT under a graphql/ subdirectory, so they aren't picked up by the normal
  // file scan.  loadMixinFiles() does a separate, targeted scan of lib/ directories,
  // only loading files that contain both `self.included` and `argument`.
  const mixinFiles = loadMixinFiles(basePath)
  const mixinRegistry = parseMixinRegistry(new Map([...files, ...mixinFiles]))

  const typeDefs: GraphQLTypeDefinition[] = []
  const resolvers: ResolverDefinition[] = []
  const skippedFiles: string[] = []

  for (const [filePath, content] of files) {
    try {
      // Try parsing as a type definition first
      const def = parseRubyTypeDefinition(content, filePath)
      if (def) {
        typeDefs.push(def)
        logger.log(
          `[NitroGraphQL]   type: ${def.name} (${def.kind}) <- ${filePath.split("/").slice(-2).join("/")}`
        )
        continue
      }

      // Try parsing as a resolver
      const resolver = parseResolverDefinition(content, filePath, mixinRegistry)
      if (resolver) {
        resolvers.push(resolver)
        logger.log(
          `[NitroGraphQL]   resolver: ${resolver.className} -> ${resolver.returnType} <- ${filePath.split("/").slice(-2).join("/")}`
        )
      } else {
        logger.log(
          `[NitroGraphQL]   ℹ️  Skipped file (no class definition): ${filePath.split("/").slice(-3).join("/")}\n` +
            `       This file doesn't contain a recognized class definition.\n` +
            `       💡 Types should inherit from: NitroGraphql::Types::BaseObject\n` +
            `       💡 Queries should inherit from: NitroGraphql::BaseQuery\n` +
            `       💡 Mutations should inherit from: NitroGraphql::BaseMutation`
        )
        skippedFiles.push(filePath)
      }
    } catch (error) {
      logger.warn(
        `[NitroGraphQL] ❌ Failed to parse ${filePath.split("/").slice(-3).join("/")}\n` +
          `    Error: ${error}\n` +
          `    ✓ Fix: Check the file syntax and class definitions\n` +
          `    💡 Common issues: invalid Ruby syntax, malformed field declarations, missing quotes`
      )
      skippedFiles.push(filePath)
    }
  }

  logger.log(
    `[NitroGraphQL] Parsed ${typeDefs.length} type definitions, ${resolvers.length} resolvers`
  )

  // Resolve argument (and return-type) inheritance from intermediate base classes.
  // e.g. UpdateQuarterlyReviewMutation < UpdateReviewMutationBase < NitroGraphql::BaseMutation
  resolveResolverInheritance(resolvers)

  // Resolve dynamic fields from `.each` blocks — requires all files to search for method defs
  resolveDynamicFields(typeDefs, files, basePath)

  // Parse registration files
  const registrationFiles = findRegistrationFiles(basePath)
  logger.log(
    `[NitroGraphQL] Found ${registrationFiles.length} registration files`
  )

  const registrations: ResolverRegistration[] = []
  for (const regFile of registrationFiles) {
    try {
      const content = fs.readFileSync(regFile, "utf-8")
      const regs = parseRegistrationFile(content)
      registrations.push(...regs)
      logger.log(
        `[NitroGraphQL]   ${regFile.split("/").slice(-4).join("/")}: ${regs.length} registrations`
      )
      for (const r of regs) {
        logger.log(
          `[NitroGraphQL]     ${r.target} ${r.fieldName} -> ${r.resolverClassName}`
        )
      }
    } catch (error) {
      logger.warn(
        `[NitroGraphQL] ❌ Failed to parse registration file ${regFile.split("/").slice(-3).join("/")}\n` +
          `    Error: ${error}\n` +
          `    ✓ Check: queries/mutations block has proper syntax\n` +
          `    💡 Expected format:\n` +
          `       queries do\n` +
          `         field :name, resolver: MyQuery\n` +
          `       end`
      )
    }
  }

  logger.log(
    `[NitroGraphQL] Found ${registrations.length} resolver registrations`
  )

  const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
  const validationErrors = validateSchemaIntegrity(schema)

  if (validationErrors.length > 0) {
    logger.warn(
      `[NitroGraphQL] Schema validation warnings:\n${validationErrors.join("\n")}`
    )
  }

  // Estimate memory usage of the schema
  const memoryUsedBytes = process.memoryUsage().heapUsed

  return {
    schema,
    typeCount: typeDefs.length,
    resolverCount: resolvers.length,
    registrationCount: registrations.length,
    errors: validationErrors,
    skippedFiles,
    memoryUsedBytes,
  }
}
