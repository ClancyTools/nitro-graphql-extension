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
  access: AccessLevel
  /** Arguments declared inline on this field inside a `do...end` block */
  fieldArgs?: ArgumentDefinition[]
}

export interface ArgumentDefinition {
  name: string
  type: string
  required: boolean
  isList: boolean
  defaultValue?: string
}

export interface ResolverDefinition {
  className: string
  returnType: string
  returnTypeIsList: boolean
  returnTypeNullable: boolean
  arguments: ArgumentDefinition[]
  fileName: string
}

export interface ResolverRegistration {
  fieldName: string
  resolverClassName: string
  target: "query" | "mutation"
  /** Access level parsed from the registration field declaration (e.g. ["private"]) */
  access?: AccessLevel
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
  /** Populated for union types — the list of member type names */
  possibleTypes?: string[]
  fileName: string
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
      } catch {
        logger.warn(`[NitroGraphQL] Failed to read file: ${fullPath}`)
      }
    }
  }
}

// ── Ruby Parsing ───────────────────────────────────────────────────────────────

/**
 * Parse a Ruby GraphQL type definition file into a structured definition.
 * Returns null for resolver classes (use parseResolverDefinition instead).
 */
export function parseRubyTypeDefinition(
  fileContent: string,
  fileName: string
): GraphQLTypeDefinition | null {
  // Remove Ruby comments (lines starting with #)
  const lines = fileContent.split("\n")
  const contentLines = lines.filter(l => !l.trim().startsWith("#"))
  const content = contentLines.join("\n")

  // --- Path 1: class-based definition (class Foo < Bar) ---
  const classMatch = content.match(/class\s+(\w+)\s*<\s*([\w:]+)/)

  if (classMatch) {
    const className = classMatch[1]
    const parentClass = classMatch[2]

    // Check if this is a resolver class — handled separately
    if (isResolverClass(parentClass)) {
      return null
    }

    // Determine kind from parent class
    const kind = inferKind(parentClass)
    if (!kind) {
      return null
    }

    // Extract graphql_name if present, otherwise derive from class name
    const graphqlNameMatch = content.match(/graphql_name\s+["'](\w+)["']/)
    const classBasedName = deriveTypeName(className)
    const name = graphqlNameMatch ? graphqlNameMatch[1] : classBasedName

    // Union types: parse possible_types members, no fields
    if (kind === "union") {
      return {
        name,
        classBasedName,
        kind: "union",
        parentClass,
        fields: [],
        implements: [],
        enumValues: [],
        possibleTypes: parsePossibleTypes(content),
        fileName,
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

    return {
      name,
      classBasedName,
      kind,
      parentClass,
      fields,
      implements: implementsList,
      enumValues,
      fileName,
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
        }
      }
    }
  }

  return null
}

/**
 * Check if the parent class indicates a resolver (BaseQuery / Resolver).
 */
function isResolverClass(parentClass: string): boolean {
  const lower = parentClass.toLowerCase()
  return (
    lower.includes("basequery") ||
    lower.includes("base_query") ||
    lower.includes("resolver") ||
    lower.includes("basemutation") ||
    lower.includes("base_mutation")
  )
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
 * and multi-line: `possible_types(\n  TypeA,\n  TypeB\n)`
 */
function parsePossibleTypes(content: string): string[] {
  // With parens (possibly multiline): possible_types(TypeA, TypeB)
  const parenMatch = content.match(/\bpossible_types\s*\(([\s\S]*?)\)/)
  if (parenMatch) {
    return extractRubyTypeNames(parenMatch[1])
  }
  // Without parens on a single line: possible_types TypeA, TypeB
  const inlineMatch = content.match(/\bpossible_types\s+([^\n]+)/)
  if (inlineMatch) {
    return extractRubyTypeNames(inlineMatch[1])
  }
  return []
}

function extractRubyTypeNames(raw: string): string[] {
  return raw
    .split(",")
    .map(t => {
      const parts = t.replace(/[()]/g, "").trim().split("::")
      const last = parts[parts.length - 1].trim()
      return last ? deriveTypeName(last) : ""
    })
    .filter(Boolean)
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
        name: snakeToCamel(fieldName),
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
        name: snakeToCamel(fieldName),
        ...parsed,
        isList: false, // belongs_to is always singular
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
        name: snakeToCamel(fieldName),
        ...parsed,
        isList: true, // has_many is always a list
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

      const isList = rest.trim().startsWith("[")
      let typePart: string
      if (isList) {
        const bracketMatch = rest.match(/^\s*\[([^\]]+)\]/)
        if (!bracketMatch) continue
        typePart = bracketMatch[1].trim()
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
  access: AccessLevel
}

/**
 * Parse the remainder of a field declaration after the name.
 * e.g. "String, null: false, access: :public"
 */
function parseFieldRest(rest: string): ParsedFieldRest | null {
  // Extract the type — first non-option argument
  // Types look like: String, ID, Boolean, Integer, Float, [SomeType], ::Module::Type
  const isList = rest.trim().startsWith("[")

  let typePart: string
  if (isList) {
    const bracketMatch = rest.match(/^\s*\[([^\]]+)\]/)
    if (!bracketMatch) {
      return null
    }
    typePart = bracketMatch[1].trim()
  } else {
    // Get everything up to the first comma or end
    const parts = rest.split(",")
    typePart = parts[0].trim()
  }

  // Clean up type — remove Ruby namespacing
  const type = normalizeRubyType(typePart)
  if (!type) {
    return null
  }

  // Parse null: option
  const nullMatch = rest.match(/null:\s*(true|false)/)
  const nullable = nullMatch ? nullMatch[1] === "true" : true

  // Parse access: option
  const access = parseAccessLevel(rest)

  return { type, nullable, isList, access }
}

/**
 * Normalize a Ruby type reference to a GraphQL type name.
 */
function normalizeRubyType(rubyType: string): string | null {
  const cleaned = rubyType.trim()

  // Handle Ruby constant paths like ::LearningDojo::Graphql::CourseVersionType
  if (cleaned.includes("::")) {
    const parts = cleaned.split("::")
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
 * Convert snake_case to camelCase.
 */
export function snakeToCamel(snake: string): string {
  return snake.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

/**
 * Parse a Ruby resolver class (BaseQuery subclass) into a ResolverDefinition.
 * These classes define `argument` declarations and a `type` return.
 */
export function parseResolverDefinition(
  fileContent: string,
  fileName: string
): ResolverDefinition | null {
  const lines = fileContent.split("\n")
  const contentLines = lines.filter(l => !l.trim().startsWith("#"))
  const content = contentLines.join("\n")

  // Extract class definition
  const classMatch = content.match(/class\s+(\w+)\s*<\s*([\w:]+)/)
  if (!classMatch) {
    return null
  }

  const className = classMatch[1]
  const parentClass = classMatch[2]

  if (!isResolverClass(parentClass)) {
    return null
  }

  // Derive the full class name from module nesting
  const modules: string[] = []
  const moduleRegex = /module\s+([\w:]+)/g
  let modMatch: RegExpExecArray | null
  while ((modMatch = moduleRegex.exec(content)) !== null) {
    modules.push(modMatch[1])
  }
  const fullClassName = [...modules, className].join("::")

  // Parse return type: `type SomeType, null: false` or `type [SomeType], null: false`
  const typeMatch = content.match(/^\s*type\s+(\[?[:\w]+\]?)\s*,?\s*(.*?)$/m)
  let returnType = "String"
  let returnTypeIsList = false
  let returnTypeNullable = true

  if (typeMatch) {
    const rawType = typeMatch[1].trim()
    const typeOpts = typeMatch[2] || ""

    returnTypeIsList = rawType.startsWith("[")
    const typeStr = rawType.replace(/^\[|\]$/g, "").trim()
    returnType = normalizeRubyType(typeStr) || "String"

    const nullMatch = typeOpts.match(/null:\s*(true|false)/)
    returnTypeNullable = nullMatch ? nullMatch[1] === "true" : true
  }

  // Parse arguments
  const args = parseArguments(content)

  return {
    className: fullClassName,
    returnType,
    returnTypeIsList,
    returnTypeNullable,
    arguments: args,
    fileName,
  }
}

/**
 * Parse `argument` declarations from Ruby resolver content.
 * Format: `argument :name, Type, required: false, default_value: "x"`
 */
export function parseArguments(content: string): ArgumentDefinition[] {
  const args: ArgumentDefinition[] = []
  const argRegex = /argument\s+:(\w+)\s*,\s*(.+)/g

  let match: RegExpExecArray | null
  while ((match = argRegex.exec(content)) !== null) {
    const argName = match[1]
    const rest = match[2]

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
  required: boolean
  isList: boolean
  defaultValue?: string
}

/**
 * Parse the remainder of an argument declaration after the name.
 */
function parseArgumentRest(rest: string): ParsedArgumentRest | null {
  const isList = rest.trim().startsWith("[")

  let typePart: string
  if (isList) {
    const bracketMatch = rest.match(/^\s*\[([^\]]+)\]/)
    if (!bracketMatch) {
      return null
    }
    typePart = bracketMatch[1].trim()
  } else {
    // Get everything up to first comma or end
    const parts = rest.split(",")
    typePart = parts[0].trim()
  }

  const type = normalizeRubyType(typePart)
  if (!type) {
    return null
  }

  // Parse required option — default is true for arguments
  const requiredMatch = rest.match(/required:\s*(true|false)/)
  const required = requiredMatch ? requiredMatch[1] === "true" : true

  // Parse default_value option
  const defaultMatch = rest.match(/default_value:\s*["']?([^"',\s]+)["']?/)
  const defaultValue = defaultMatch ? defaultMatch[1] : undefined

  // If there's a default_value, the argument is effectively optional
  const effectiveRequired = defaultValue !== undefined ? false : required

  return { type, required: effectiveRequired, isList, defaultValue }
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
    // Match a field declaration whose line ends with `do`
    const fieldDoMatch = line.match(/\bfield\s+:(\w+).*\bdo\s*$/)
    if (fieldDoMatch) {
      const fieldName = snakeToCamel(fieldDoMatch[1])
      const baseIndent = (line.match(/^(\s*)/)?.[1] ?? "").length
      const blockArgs: ArgumentDefinition[] = []

      i++
      while (i < lines.length) {
        const innerLine = lines[i]
        const innerTrimmed = innerLine.trim()
        const innerIndent = (innerLine.match(/^(\s*)/)?.[1] ?? "").length

        // Stop at an `end` at or before the field's indentation level
        if (innerTrimmed === "end" && innerIndent <= baseIndent) break

        const argMatch = innerTrimmed.match(/^argument\s+:(\w+)\s*,\s*(.+)/)
        if (argMatch) {
          const parsed = parseArgumentRest(argMatch[2])
          if (parsed) {
            blockArgs.push({
              name: snakeToCamel(argMatch[1]),
              ...parsed,
            })
          }
        }
        i++
      }

      if (blockArgs.length > 0) {
        result.set(fieldName, blockArgs)
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

  // Split into queries and mutations blocks
  const queriesBlock = extractBlock(fileContent, "queries")
  const mutationsBlock = extractBlock(fileContent, "mutations")

  if (queriesBlock) {
    parseRegistrationBlock(queriesBlock, "query", registrations)
  }
  if (mutationsBlock) {
    parseRegistrationBlock(mutationsBlock, "mutation", registrations)
  }

  return registrations
}

/**
 * Extract a block between `name do` and its matching `end`.
 */
function extractBlock(content: string, blockName: string): string | null {
  const blockRegex = new RegExp(
    `\\b${blockName}\\s+do\\b([\\s\\S]*?)^\\s*end`,
    "m"
  )
  const match = content.match(blockRegex)
  return match ? match[1] : null
}

/**
 * Parse field registrations within a queries/mutations block.
 */
function parseRegistrationBlock(
  block: string,
  target: "query" | "mutation",
  registrations: ResolverRegistration[]
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

  for (let i = 0; i < fieldPositions.length; i++) {
    const { name: fieldName } = fieldPositions[i]
    const start = fieldPositions[i].start
    const end =
      i + 1 < fieldPositions.length ? fieldPositions[i + 1].start : block.length
    const fieldBlock = block.slice(start, end)

    // Find resolver: ::Module::Class or resolver: Module::Class within this block
    const resolverMatch = fieldBlock.match(/resolver:\s*:*([\w][:\w]*)/)
    if (!resolverMatch) {
      continue
    }

    const access = parseAccessLevel(fieldBlock)

    registrations.push({
      fieldName: snakeToCamel(fieldName),
      resolverClassName: resolverMatch[1],
      target,
      access,
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

  for (const td of typeDefs) {
    typeMap.set(td.name, td)
    // If the graphql_name differs from the class-derived name, add an alias
    if (td.classBasedName !== td.name) {
      aliasMap.set(td.classBasedName, td.name)
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

  function resolveOutputType(
    typeName: string,
    isList: boolean,
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
    if (isList) {
      type = new GraphQLList(new GraphQLNonNull(baseType))
    }
    if (!nullable) {
      type = new GraphQLNonNull(type)
    }
    return type
  }

  function resolveInputType(
    typeName: string,
    isList: boolean,
    nullable: boolean
  ): GraphQLInputType {
    let baseType = getOrBuildType(typeName) as GraphQLInputType
    if (!baseType) {
      baseType = GraphQLString
    }

    let type: GraphQLInputType = baseType
    if (isList) {
      type = new GraphQLList(new GraphQLNonNull(baseType))
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

  function buildObjectType(def: GraphQLTypeDefinition): GraphQLObjectType {
    const obj = new GraphQLObjectType({
      name: def.name,
      fields: () => {
        const fieldConfig: GraphQLFieldConfigMap<any, any> = {}
        // Inherited fields from parent chain (applied first so child fields override)
        for (const field of collectInheritedFields(def)) {
          const fc: any = {
            type: resolveOutputType(field.type, field.isList, !field.nullable),
          }
          if (field.fieldArgs && field.fieldArgs.length > 0) {
            fc.args = buildFieldArgs(field.fieldArgs)
          }
          fieldConfig[field.name] = fc
        }
        // Own fields (override any inherited with same name)
        for (const field of def.fields) {
          const fc: any = {
            type: resolveOutputType(field.type, field.isList, !field.nullable),
          }
          if (field.fieldArgs && field.fieldArgs.length > 0) {
            fc.args = buildFieldArgs(field.fieldArgs)
          }
          fieldConfig[field.name] = fc
        }
        // Merge any interface fields not already provided, so that GraphQL
        // interface-conformance validation passes even when the Ruby code relies
        // on inheritance to satisfy the interface contract.
        for (const ifaceName of def.implements) {
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
                  fieldConfig[field.name] = { type: ifaceFieldType }
                }
              } else {
                fieldConfig[field.name] = { type: ifaceFieldType }
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
        return def.implements
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
      fields: () => {
        const fieldConfig: GraphQLFieldConfigMap<any, any> = {}
        for (const field of def.fields) {
          const fc: any = {
            type: resolveOutputType(field.type, field.isList, !field.nullable),
          }
          if (field.fieldArgs && field.fieldArgs.length > 0) {
            fc.args = buildFieldArgs(field.fieldArgs)
          }
          fieldConfig[field.name] = fc
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
      fields: () => {
        const fieldConfig: GraphQLInputFieldConfigMap = {}
        // Inherited fields from parent input type chain
        for (const field of collectInheritedFields(def)) {
          fieldConfig[field.name] = {
            type: resolveInputType(field.type, field.isList, !field.nullable),
          }
        }
        // Own fields (override any inherited)
        for (const field of def.fields) {
          fieldConfig[field.name] = {
            type: resolveInputType(field.type, field.isList, !field.nullable),
          }
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
      values,
    })
    registry.set(def.name, enumType)
    return enumType
  }

  function buildScalarType(def: GraphQLTypeDefinition): GraphQLScalarType {
    const scalar = new GraphQLScalarType({ name: def.name })
    registry.set(def.name, scalar)
    return scalar
  }

  function buildUnionType(def: GraphQLTypeDefinition): GraphQLUnionType {
    // Register a placeholder immediately to break any circular references
    // before the thunk resolves the member types.
    const union = new GraphQLUnionType({
      name: def.name,
      types: () => {
        const memberTypes: GraphQLObjectType[] = []
        for (const typeName of def.possibleTypes ?? []) {
          const t = getOrBuildType(typeName)
          if (t instanceof GraphQLObjectType) {
            memberTypes.push(t)
          }
        }
        if (memberTypes.length === 0) {
          // Placeholder so GraphQL doesn't reject an empty union
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
      let argType = resolveInputType(argDef.type, argDef.isList, true)
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
   * We intentionally do NOT fall back to class-name-only matching: two
   * namespaces may define resolvers with the same leaf class name but
   * different arguments (e.g. Warranty::PendingProposedItemChangesQuery and
   * Projects::PendingProposedItemChangesQuery).  A wrong match would attach
   * the wrong required arguments to the registered field.
   */
  function findResolver(
    resolverClassName: string
  ): ResolverDefinition | undefined {
    // Strip leading :: for matching
    const normalized = resolverClassName.replace(/^::/, "")
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
    const resolver = findResolver(reg.resolverClassName)
    if (!resolver) {
      logger.log(
        `[NitroGraphQL]   UNRESOLVED ${reg.target} '${reg.fieldName}': resolver class '${reg.resolverClassName}' not found in parsed resolvers`
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

    const returnType = resolveOutputType(
      resolver.returnType,
      resolver.returnTypeIsList,
      resolver.returnTypeNullable
    )

    const args = buildFieldArgs(resolver.arguments)

    const fieldConfig: any = { type: returnType }
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
          queryFields[name] = { type: field.type }
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
          mutationFields[name] = { type: field.type }
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
  })
}

/**
 * Validate that a schema is well-formed.
 * Returns errors array — empty means valid.
 */
export function validateSchemaIntegrity(schema: GraphQLSchema): string[] {
  const errors = validateSchema(schema)
  return errors.map(e => e.message)
}

// ── Full Build Pipeline ────────────────────────────────────────────────────────

export interface SchemaBuildResult {
  schema: GraphQLSchema
  typeCount: number
  resolverCount: number
  registrationCount: number
  errors: string[]
  skippedFiles: string[]
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
      const resolver = parseResolverDefinition(content, filePath)
      if (resolver) {
        resolvers.push(resolver)
        logger.log(
          `[NitroGraphQL]   resolver: ${resolver.className} -> ${resolver.returnType} <- ${filePath.split("/").slice(-2).join("/")}`
        )
      } else {
        logger.log(
          `[NitroGraphQL]   skipped (no class match): ${filePath.split("/").slice(-2).join("/")}`
        )
        skippedFiles.push(filePath)
      }
    } catch (error) {
      logger.warn(`[NitroGraphQL] Failed to parse ${filePath}: ${error}`)
      skippedFiles.push(filePath)
    }
  }

  logger.log(
    `[NitroGraphQL] Parsed ${typeDefs.length} type definitions, ${resolvers.length} resolvers`
  )

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
        `[NitroGraphQL] Failed to parse registration file ${regFile}: ${error}`
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

  return {
    schema,
    typeCount: typeDefs.length,
    resolverCount: resolvers.length,
    registrationCount: registrations.length,
    errors: validationErrors,
    skippedFiles,
  }
}
