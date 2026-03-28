import * as vscode from "vscode"
import {
  GraphQLSchema,
  GraphQLType,
  GraphQLNamedType,
  parse,
  visit,
  TypeInfo,
  visitWithTypeInfo,
  isNonNullType,
  isListType,
} from "graphql"
import { findGraphQLTemplates } from "./queryFinder"

/**
 * Hover provider that shows GraphQL type information for fields and operations.
 *
 * - For query/mutation/subscription root fields: shows operation kind, return
 *   type, and all arguments with their types and required status.
 * - For nested fields: shows field type and parent type.
 * - For any field with a description: appends it as documentation.
 */
export class GraphQLTypeHoverProvider implements vscode.HoverProvider {
  constructor(private readonly getSchema: () => GraphQLSchema | null) {}

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | null {
    const schema = this.getSchema()
    if (!schema) return null

    const text = document.getText()
    const templates = findGraphQLTemplates(text)

    for (const template of templates) {
      const templateLineCount = template.query.split("\n").length
      const templateEndLine = template.startLine + templateLineCount - 1

      if (
        position.line < template.startLine ||
        position.line > templateEndLine
      ) {
        continue
      }

      // Compute cursor position relative to the query text start
      const relLine = position.line - template.startLine
      const relCol =
        position.line === template.startLine
          ? position.character - template.startColumn
          : position.character

      if (relCol < 0) continue

      const offset = lineColToOffset(template.query, relLine, relCol)
      if (offset < 0) continue

      try {
        const content = buildHoverContent(schema, template.query, offset)
        if (content) {
          return new vscode.Hover(content)
        }
      } catch {
        // Ignore parse errors (invalid/partial queries)
      }
    }

    return null
  }
}

/**
 * Convert a 0-based (line, column) within a text string to a character offset.
 */
export function lineColToOffset(
  text: string,
  line: number,
  col: number
): number {
  const lines = text.split("\n")
  if (line < 0 || line >= lines.length) return -1
  let offset = 0
  for (let i = 0; i < line; i++) {
    offset += lines[i].length + 1 // +1 for the newline character
  }
  return offset + Math.min(col, lines[line].length)
}

/**
 * Walk the parsed query AST using graphql's TypeInfo to find the field at
 * the given character offset and build hover documentation for it.
 */
export function buildHoverContent(
  schema: GraphQLSchema,
  query: string,
  offset: number
): vscode.MarkdownString | null {
  let doc: ReturnType<typeof parse>
  try {
    doc = parse(query)
  } catch {
    return null
  }

  const typeInfo = new TypeInfo(schema)
  let result: vscode.MarkdownString | null = null

  visit(
    doc,
    visitWithTypeInfo(typeInfo, {
      Field: {
        enter(node) {
          if (!node.name.loc) return

          const nameStart = node.name.loc.start
          const nameEnd = node.name.loc.end

          // Only show hover when cursor is on the field name token
          if (offset < nameStart || offset > nameEnd) return

          const fieldDef = typeInfo.getFieldDef()
          const parentType = typeInfo.getParentType()
          const fieldType = typeInfo.getType()

          if (!fieldDef || !parentType || !fieldType) return

          const md = new vscode.MarkdownString()
          md.isTrusted = true

          const queryRoot = schema.getQueryType()
          const mutationRoot = schema.getMutationType()
          const subscriptionRoot = schema.getSubscriptionType()

          const isQueryField = queryRoot?.name === parentType.name
          const isMutationField = mutationRoot?.name === parentType.name
          const isSubscriptionField = subscriptionRoot?.name === parentType.name
          const isRootField =
            isQueryField || isMutationField || isSubscriptionField

          if (isRootField) {
            const opKind = isQueryField
              ? "query"
              : isMutationField
                ? "mutation"
                : "subscription"
            md.appendMarkdown(`**${node.name.value}** _(${opKind})_\n\n`)

            // Build return type display with potential clickable link for custom types
            const returnTypeString = typeToString(fieldType)
            const baseReturnTypeName = getBaseTypeName(fieldType)
            const returnTypeFilePath = baseReturnTypeName
              ? getTypeFilePath(schema, baseReturnTypeName)
              : null

            if (returnTypeFilePath) {
              const returnTypeLink = makeFileCommandLink(
                returnTypeString,
                returnTypeFilePath
              )
              md.appendMarkdown(`**Returns:** ${returnTypeLink}\n\n`)
            } else {
              md.appendMarkdown(`**Returns:** \`${returnTypeString}\`\n\n`)
            }

            if (fieldDef.args.length > 0) {
              md.appendMarkdown(`**Arguments:**\n\n`)
              for (const arg of fieldDef.args) {
                const isRequired =
                  isNonNullType(arg.type) && arg.defaultValue === undefined
                const requiredMark = isRequired ? " _(required)_" : ""
                const defaultStr =
                  arg.defaultValue !== undefined
                    ? ` = \`${JSON.stringify(arg.defaultValue)}\``
                    : ""
                md.appendMarkdown(
                  `- \`${arg.name}\`: \`${typeToString(arg.type)}\`${requiredMark}${defaultStr}\n`
                )
              }
              md.appendMarkdown("\n")
            }

            // Resolver metadata from schema extensions
            const ext = fieldDef.extensions as
              | Record<string, unknown>
              | undefined
            if (ext?.resolverClass) {
              md.appendMarkdown("---\n\n")
              const resolverFile = ext.resolverFile as string | undefined
              if (resolverFile) {
                const link = makeFileCommandLink(
                  String(ext.resolverClass),
                  resolverFile
                )
                md.appendMarkdown(`**Resolver:** ${link}\n\n`)
              } else {
                md.appendMarkdown(`**Resolver:** \`${ext.resolverClass}\`\n\n`)
              }
              const access = ext.access as string[] | undefined
              if (access && access.length > 0) {
                const accessStr = access.map(a => `:${a}`).join(", ")
                md.appendMarkdown(`**Access:** ${accessStr}\n\n`)
              }
            }
          } else {
            md.appendMarkdown(`**${node.name.value}**\n\n`)

            if (fieldDef.description) {
              md.appendMarkdown(`${fieldDef.description}\n\n`)
            }

            // Build type display with potential clickable link for custom types
            const typeString = typeToString(fieldType)
            const baseTypeName = getBaseTypeName(fieldType)
            const typeFilePath = baseTypeName
              ? getTypeFilePath(schema, baseTypeName)
              : null

            if (typeFilePath) {
              const typeLink = makeFileCommandLink(typeString, typeFilePath)
              md.appendMarkdown(`**Type:** ${typeLink}\n\n`)
            } else {
              md.appendMarkdown(`**Type:** \`${typeString}\`\n\n`)
            }

            // Make parent type clickable if it has a file path
            const parentTypeFilePath = getTypeFilePath(schema, parentType.name)
            if (parentTypeFilePath) {
              const parentTypeLink = makeFileCommandLink(
                parentType.name,
                parentTypeFilePath
              )
              md.appendMarkdown(`**On:** ${parentTypeLink}\n\n`)
            } else {
              md.appendMarkdown(`**On:** \`${parentType.name}\`\n\n`)
            }

            // Show base type description if it's different from the field type
            // (e.g., for list fields, show the item type's description)
            if (baseTypeName) {
              const baseTypeDesc = getTypeDescription(schema, baseTypeName)
              if (baseTypeDesc && baseTypeName !== parentType.name) {
                md.appendMarkdown(
                  `**Item Type:** ${baseTypeName}\n\n${baseTypeDesc}\n\n`
                )
              }
            }

            if (fieldDef.args.length > 0) {
              md.appendMarkdown(`**Arguments:**\n\n`)
              for (const arg of fieldDef.args) {
                const isRequired =
                  isNonNullType(arg.type) && arg.defaultValue === undefined
                const requiredMark = isRequired ? " _(required)_" : ""
                md.appendMarkdown(
                  `- \`${arg.name}\`: \`${typeToString(arg.type)}\`${requiredMark}\n`
                )
              }
              md.appendMarkdown("\n")
            }
          }

          // For root fields (queries/mutations), show description at the end
          if (isRootField && fieldDef.description) {
            md.appendMarkdown(`---\n\n${fieldDef.description}`)
          }

          result = md
        },
      },
    })
  )

  return result
}

function typeToString(type: GraphQLType): string {
  if (isNonNullType(type)) return `${typeToString(type.ofType)}!`
  if (isListType(type)) return `[${typeToString(type.ofType)}]`
  return (type as GraphQLNamedType).name
}

/**
 * Extract the base (named) type from a GraphQL type, stripping away non-null and list wrappers.
 */
export function getBaseTypeName(type: GraphQLType): string | null {
  if (isNonNullType(type) || isListType(type)) {
    return getBaseTypeName(type.ofType)
  }
  const namedType = type as GraphQLNamedType
  return namedType.name || null
}

/**
 * Get the file path for a type from the schema's typeFileMap extensions.
 * Returns null if the type is not a custom type or no mapping exists.
 */
function getTypeFilePath(
  schema: GraphQLSchema,
  typeName: string
): string | null {
  const ext = schema.extensions as Record<string, unknown> | undefined
  const typeFileMap = ext?.typeFileMap as Record<string, string> | undefined
  return (typeFileMap && typeFileMap[typeName]) || null
}

/**
 * Get the description for a named type from the schema.
 * Returns null if the type is not found or has no description.
 */
function getTypeDescription(
  schema: GraphQLSchema,
  typeName: string
): string | null {
  const type = schema.getType(typeName)
  return (type && "description" in type && type.description) || null
}

/**
 * Build a trusted MarkdownString command link that opens a file.
 * Holding Cmd/Ctrl and clicking the rendered link opens the file in the editor.
 */
export function makeFileCommandLink(label: string, filePath: string): string {
  const fileUri = `file://${filePath}`
  const encodedArgs = encodeURIComponent(JSON.stringify([fileUri]))
  return `[\`${label}\`](command:vscode.open?${encodedArgs})`
}
