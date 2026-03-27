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

export interface GraphQLTypeDefinition {
  name: string
  kind: "object" | "input" | "interface" | "enum" | "scalar" | "mutation"
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

  // Determine kind from parent class
  const kind = inferKind(parentClass)
  if (!kind) {
    return null
  }

  // Extract graphql_name if present, otherwise derive from class name
  const graphqlNameMatch = content.match(/graphql_name\s+["'](\w+)["']/)
  const name = graphqlNameMatch
    ? graphqlNameMatch[1]
    : deriveTypeName(className)

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
    kind,
    parentClass,
    fields,
    implements: implementsList,
    enumValues,
    fileName,
  }
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
  if (lower.includes("mutation")) {
    return "mutation"
  }
  if (lower.includes("baseobject") || lower.includes("object")) {
    return "object"
  }
  return null
}

/**
 * Derive a GraphQL type name from a Ruby class name.
 * e.g. "CourseType" → "Course", "AudienceInterface" → "AudienceInterface"
 */
function deriveTypeName(className: string): string {
  // Strip "Type" suffix for object types, keep others
  if (className.endsWith("Type") && !className.endsWith("InputType")) {
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
 * Build a GraphQLSchema from parsed Ruby type definitions.
 */
export function buildGraphQLSchema(
  typeDefs: GraphQLTypeDefinition[]
): GraphQLSchema {
  // Collect all types by name for cross-referencing
  const typeMap = new Map<string, GraphQLTypeDefinition>()
  for (const td of typeDefs) {
    typeMap.set(td.name, td)
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

    const def = typeMap.get(name)
    if (!def) {
      return null
    }

    // Build the type based on kind
    switch (def.kind) {
      case "object":
      case "mutation":
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

  // Find the Queries and Mutations root types
  const queriesDef = typeDefs.find(
    t => t.name === "Queries" || t.name === "Query" || t.name === "QueryType"
  )
  const mutationsDef = typeDefs.find(
    t =>
      t.name === "Mutations" ||
      t.name === "Mutation" ||
      t.name === "MutationType"
  )

  // Pre-build all types so they end up in the registry
  for (const def of typeDefs) {
    if (!registry.has(def.name)) {
      getOrBuildType(def.name)
    }
  }

  const queryType = queriesDef
    ? (registry.get(queriesDef.name) as GraphQLObjectType) || undefined
    : undefined

  const mutationType = mutationsDef
    ? (registry.get(mutationsDef.name) as GraphQLObjectType) || undefined
    : undefined

  if (!queryType) {
    throw new Error(
      "[NitroGraphQL] No Query/Queries root type found in schema files"
    )
  }

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
  errors: string[]
  skippedFiles: string[]
}

/**
 * Full pipeline: discover → load → parse → build → validate.
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
  const skippedFiles: string[] = []

  for (const [filePath, content] of files) {
    try {
      const def = parseRubyTypeDefinition(content, filePath)
      if (def) {
        typeDefs.push(def)
      }
    } catch (error) {
      console.warn(`[NitroGraphQL] Failed to parse ${filePath}: ${error}`)
      skippedFiles.push(filePath)
    }
  }

  console.log(`[NitroGraphQL] Parsed ${typeDefs.length} type definitions`)

  const schema = buildGraphQLSchema(typeDefs)
  const validationErrors = validateSchemaIntegrity(schema)

  if (validationErrors.length > 0) {
    console.warn(
      `[NitroGraphQL] Schema validation warnings:\n${validationErrors.join("\n")}`
    )
  }

  return {
    schema,
    typeCount: typeDefs.length,
    errors: validationErrors,
    skippedFiles,
  }
}
