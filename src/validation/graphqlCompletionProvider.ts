import * as vscode from "vscode"
import {
  GraphQLSchema,
  GraphQLType,
  GraphQLNamedType,
  GraphQLCompositeType,
  parse,
  visit,
  TypeInfo,
  visitWithTypeInfo,
  isObjectType,
  isInterfaceType,
  isUnionType,
  isNonNullType,
  isListType,
  getNamedType,
} from "graphql"
import { findGraphQLTemplates } from "./queryFinder"

/**
 * Completion provider that suggests GraphQL field names as the user types
 * inside a gql template literal.
 *
 * - Inside a query/mutation/subscription root: suggests all root fields.
 * - Inside a nested selection set: suggests fields of the parent type.
 * - Inside a union type selection set: suggests inline fragment spreads for
 *   each member type.
 * - Always includes `__typename` as a completion option.
 */
export class GraphQLCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(private readonly getSchema: () => GraphQLSchema | null) {}

  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | null {
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
      if (offset < 0) return null

      try {
        const contextType = getTypeContextAtOffset(
          schema,
          template.query,
          offset
        )
        if (!contextType) return null
        return buildCompletionItems(contextType)
      } catch {
        return null
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
 * Repair a partial/incomplete GraphQL query by appending closing braces so
 * it can be parsed. Only appends braces to balance what is open at
 * `atOffset` in the text.
 */
export function repairQuery(query: string, atOffset: number): string {
  const before = query.slice(0, atOffset)
  let depth = 0
  let inString = false
  let stringChar = ""

  for (let i = 0; i < before.length; i++) {
    const ch = before[i]
    if (inString) {
      if (ch === "\\") {
        i++ // skip escaped char
        continue
      }
      if (ch === stringChar) inString = false
      continue
    }
    if (ch === '"' || ch === "'") {
      inString = true
      stringChar = ch
      continue
    }
    if (ch === "{") depth++
    else if (ch === "}") depth--
  }

  if (depth <= 0) return query
  // Add a valid field placeholder at each open level so selection sets are
  // non-empty (GraphQL requires at least one selection per selection set).
  return before + "__typename\n}\n".repeat(depth)
}

/**
 * Determine the GraphQL composite type that owns the selection set at the
 * given cursor offset within the query text. Uses AST walking with TypeInfo
 * after repairing the query to ensure it is parseable.
 *
 * Returns the innermost matching type (e.g., if the cursor is inside
 * `user { profile { | } }`, returns the Profile type).
 */
export function getTypeContextAtOffset(
  schema: GraphQLSchema,
  query: string,
  cursorOffset: number
): GraphQLCompositeType | null {
  const repaired = repairQuery(query, cursorOffset)

  let doc: ReturnType<typeof parse>
  try {
    doc = parse(repaired)
  } catch {
    return null
  }

  const typeInfo = new TypeInfo(schema)
  let contextType: GraphQLCompositeType | null = null

  visit(
    doc,
    visitWithTypeInfo(typeInfo, {
      OperationDefinition: {
        enter(node) {
          const ss = node.selectionSet
          if (!ss?.loc) return
          if (ss.loc.start <= cursorOffset && cursorOffset <= ss.loc.end) {
            let rootType: GraphQLCompositeType | null | undefined
            switch (node.operation) {
              case "mutation":
                rootType = schema.getMutationType()
                break
              case "subscription":
                rootType = schema.getSubscriptionType()
                break
              default:
                rootType = schema.getQueryType()
            }
            if (rootType) contextType = rootType
          }
        },
      },

      Field: {
        enter(node) {
          // Only match if cursor is inside this field's sub-selection set
          const ss = node.selectionSet
          if (!ss?.loc) return
          if (ss.loc.start <= cursorOffset && cursorOffset <= ss.loc.end) {
            const fieldType = typeInfo.getType()
            if (fieldType) {
              const named = getNamedType(fieldType)
              if (
                isObjectType(named) ||
                isInterfaceType(named) ||
                isUnionType(named)
              ) {
                contextType = named
              }
            }
          }
        },
      },

      InlineFragment: {
        enter(node) {
          const ss = node.selectionSet
          if (!ss?.loc) return
          if (ss.loc.start <= cursorOffset && cursorOffset <= ss.loc.end) {
            const fragType = typeInfo.getType()
            if (fragType) {
              const named = getNamedType(fragType)
              if (isObjectType(named) || isInterfaceType(named)) {
                contextType = named
              }
            }
          }
        },
      },

      FragmentDefinition: {
        enter(node) {
          const ss = node.selectionSet
          if (!ss?.loc) return
          if (ss.loc.start <= cursorOffset && cursorOffset <= ss.loc.end) {
            const typeName = node.typeCondition.name.value
            const type = schema.getType(typeName)
            if (type && (isObjectType(type) || isInterfaceType(type))) {
              contextType = type
            }
          }
        },
      },
    })
  )

  return contextType
}

/**
 * Build VS Code completion items for the fields of a GraphQL composite type.
 *
 * - Union types: inline fragment spread snippets for each member type.
 * - Object/Interface types: field completions with type detail, sub-selection
 *   snippets for object-valued fields, and argument snippets for required args.
 * - Always adds `__typename`.
 */
export function buildCompletionItems(
  type: GraphQLCompositeType
): vscode.CompletionItem[] {
  const items: vscode.CompletionItem[] = []

  if (isUnionType(type)) {
    for (const memberType of type.getTypes()) {
      const item = new vscode.CompletionItem(
        `... on ${memberType.name}`,
        vscode.CompletionItemKind.Snippet
      )
      item.insertText = new vscode.SnippetString(
        `... on ${memberType.name} {\n  $0\n}`
      )
      item.detail = `Inline fragment on ${memberType.name}`
      if (memberType.description) {
        item.documentation = new vscode.MarkdownString(memberType.description)
      }
      items.push(item)
    }
  } else if (isObjectType(type) || isInterfaceType(type)) {
    const fields = type.getFields()
    for (const [fieldName, field] of Object.entries(fields)) {
      const item = new vscode.CompletionItem(
        fieldName,
        vscode.CompletionItemKind.Field
      )
      item.detail = typeToString(field.type)

      const namedFieldType = getNamedType(field.type)
      const hasSubfields =
        isObjectType(namedFieldType) ||
        isInterfaceType(namedFieldType) ||
        isUnionType(namedFieldType)

      // Build a snippet that includes required arguments and sub-selection braces
      const requiredArgs = field.args
        ? field.args.filter(
            a => isNonNullType(a.type) && a.defaultValue === undefined
          )
        : []

      if (requiredArgs.length > 0) {
        const argStr = requiredArgs
          .map((a, i) => `${a.name}: $${i + 1}`)
          .join(", ")
        if (hasSubfields) {
          item.insertText = new vscode.SnippetString(
            `${fieldName}(${argStr}) {\n  $${requiredArgs.length + 1}\n}`
          )
        } else {
          item.insertText = new vscode.SnippetString(`${fieldName}(${argStr})`)
        }
      } else if (hasSubfields) {
        item.insertText = new vscode.SnippetString(`${fieldName} {\n  $0\n}`)
      }

      if (field.description) {
        item.documentation = new vscode.MarkdownString(field.description)
      }

      items.push(item)
    }
  }

  // __typename is always valid on any type
  const typenameItem = new vscode.CompletionItem(
    "__typename",
    vscode.CompletionItemKind.Field
  )
  typenameItem.detail = "String!"
  typenameItem.documentation = new vscode.MarkdownString(
    "The name of the current object type"
  )
  items.push(typenameItem)

  return items
}

function typeToString(type: GraphQLType): string {
  if (isNonNullType(type)) return `${typeToString(type.ofType)}!`
  if (isListType(type)) return `[${typeToString(type.ofType)}]`
  return (getNamedType(type) as GraphQLNamedType).name
}
