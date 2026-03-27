import * as fs from "fs"
import * as path from "path"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInterfaceType,
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
}

export interface GraphQLTypeDefinition {
  name: string
  /** The name derived from the Ruby class name (before graphql_name override) */
  classBasedName: string
  kind: "object" | "input" | "interface" | "enum" | "scalar"
  parentClass: string
  fields: FieldDefinition[]
  implements: string[]
  enumValues: string[]
  fileName: string
}

// ── File Discovery ─────────────────────────────────────────────────────────────

/**
 * Recursively find all directories named "graphql" under basePath.
 * Follows the CoBRA pattern: components/* /app/graphql/* /graphql/
 */
export function findGraphQLDirectories(basePath: string): string[] {
  const results: string[] = []

  function walk(dir: string): void {
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

      walk(fullPath)
    }
  }

  walk(basePath)
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
        console.warn(`[NitroGraphQL] Failed to read file: ${fullPath}`)
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

  // Extract class definition
  const classMatch = content.match(/class\s+(\w+)\s*<\s*([\w:]+)/)
  if (!classMatch) {
    return null
  }

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

  // Extract implements
  const implementsList: string[] = []
  const implementsRegex = /implements\s+:*([:\w]+)/g
  let implMatch: RegExpExecArray | null
  while ((implMatch = implementsRegex.exec(content)) !== null) {
    const raw = implMatch[1]
    // Convert Ruby constant path to a simple name
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

  // Extract fields
  const fields = parseFields(content)

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
  if (lower.includes("baseobject") || lower.includes("object")) {
    return "object"
  }
  return null
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
function parseFields(content: string): FieldDefinition[] {
  const fields: FieldDefinition[] = []

  // Match field declarations — handles multiline via iterating line by line
  // Pattern: field :name, Type, options...
  const fieldRegex = /field\s+:(\w+)\s*,\s*(.+)/g

  let match: RegExpExecArray | null
  while ((match = fieldRegex.exec(content)) !== null) {
    const fieldName = match[1]
    const rest = match[2]

    const parsed = parseFieldRest(rest)
    if (parsed) {
      fields.push({
        name: fieldName,
        ...parsed,
      })
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
  // Match: field :field_name, resolver: ::Module::Class (multiline-safe)
  // The field name and resolver may be on different lines
  const fieldRegex = /field\s+:(\w+)\s*,\s*\n?\s*resolver:\s*:*([\w:]+)/g

  let match: RegExpExecArray | null
  while ((match = fieldRegex.exec(block)) !== null) {
    const fieldName = snakeToCamel(match[1])
    const resolverClassName = match[2]

    registrations.push({
      fieldName,
      resolverClassName,
      target,
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
    return results
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    // Look for lib/<component_name>/graphql.rb
    const libDir = path.join(componentsDir, entry.name, "lib")
    try {
      const libEntries = fs.readdirSync(libDir, { withFileTypes: true })
      for (const libEntry of libEntries) {
        if (!libEntry.isDirectory()) {
          continue
        }
        const gqlFile = path.join(libDir, libEntry.name, "graphql.rb")
        try {
          fs.accessSync(gqlFile, fs.constants.R_OK)
          results.push(gqlFile)
        } catch {
          // File doesn't exist, skip
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
      // Fallback to String for unknown types
      baseType = GraphQLString
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
    if (registry.has(name)) {
      return registry.get(name)!
    }

    // Check alias map: class-derived name → graphql name
    const aliased = aliasMap.get(name)
    if (aliased && registry.has(aliased)) {
      return registry.get(aliased)!
    }

    let def = typeMap.get(name)
    if (!def && aliased) {
      def = typeMap.get(aliased)
    }
    if (!def) {
      return null
    }

    // Build the type based on kind
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
      default:
        return null
    }
  }

  function buildObjectType(def: GraphQLTypeDefinition): GraphQLObjectType {
    const obj = new GraphQLObjectType({
      name: def.name,
      fields: () => {
        const fieldConfig: GraphQLFieldConfigMap<any, any> = {}
        for (const field of def.fields) {
          fieldConfig[field.name] = {
            type: resolveOutputType(field.type, field.isList, !field.nullable),
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
          fieldConfig[field.name] = {
            type: resolveOutputType(field.type, field.isList, !field.nullable),
          }
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
   */
  function findResolver(
    resolverClassName: string
  ): ResolverDefinition | undefined {
    // Strip leading :: for matching
    const normalized = resolverClassName.replace(/^::/, "")
    for (const [key, resolver] of resolverMap) {
      if (
        key === normalized ||
        key.endsWith("::" + normalized.split("::").pop())
      ) {
        return resolver
      }
    }
    // Also try matching just the class name
    const className = normalized.split("::").pop()!
    for (const [, resolver] of resolverMap) {
      const resolverClass = resolver.className.split("::").pop()
      if (resolverClass === className) {
        return resolver
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
      | GraphQLEnumType
      | GraphQLInputObjectType
      | GraphQLScalarType =>
      t instanceof GraphQLObjectType ||
      t instanceof GraphQLInterfaceType ||
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
  console.log(`[NitroGraphQL] Discovering GraphQL files in: ${basePath}`)

  const directories = findGraphQLDirectories(basePath)
  console.log(`[NitroGraphQL] Found ${directories.length} graphql directories`)

  if (directories.length === 0) {
    throw new Error(
      `[NitroGraphQL] No graphql directories found under ${basePath}`
    )
  }

  const files = loadGraphQLTypeFiles(directories)
  console.log(`[NitroGraphQL] Loaded ${files.size} Ruby files`)

  const typeDefs: GraphQLTypeDefinition[] = []
  const resolvers: ResolverDefinition[] = []
  const skippedFiles: string[] = []

  for (const [filePath, content] of files) {
    try {
      // Try parsing as a type definition first
      const def = parseRubyTypeDefinition(content, filePath)
      if (def) {
        typeDefs.push(def)
        continue
      }

      // Try parsing as a resolver
      const resolver = parseResolverDefinition(content, filePath)
      if (resolver) {
        resolvers.push(resolver)
      }
    } catch (error) {
      console.warn(`[NitroGraphQL] Failed to parse ${filePath}: ${error}`)
      skippedFiles.push(filePath)
    }
  }

  console.log(
    `[NitroGraphQL] Parsed ${typeDefs.length} type definitions, ${resolvers.length} resolvers`
  )

  // Parse registration files
  const registrationFiles = findRegistrationFiles(basePath)
  console.log(
    `[NitroGraphQL] Found ${registrationFiles.length} registration files`
  )

  const registrations: ResolverRegistration[] = []
  for (const regFile of registrationFiles) {
    try {
      const content = fs.readFileSync(regFile, "utf-8")
      const regs = parseRegistrationFile(content)
      registrations.push(...regs)
    } catch (error) {
      console.warn(
        `[NitroGraphQL] Failed to parse registration file ${regFile}: ${error}`
      )
    }
  }

  console.log(
    `[NitroGraphQL] Found ${registrations.length} resolver registrations`
  )

  const schema = buildGraphQLSchema(typeDefs, resolvers, registrations)
  const validationErrors = validateSchemaIntegrity(schema)

  if (validationErrors.length > 0) {
    console.warn(
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
