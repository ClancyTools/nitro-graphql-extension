import * as vscode from "vscode"
import {
  GraphQLSchema,
  parse,
  visit,
  DocumentNode,
  OperationDefinitionNode,
  FragmentDefinitionNode,
  SelectionSetNode,
  FieldNode,
  InlineFragmentNode,
  FragmentSpreadNode,
  VariableNode,
  ObjectFieldNode,
} from "graphql"
import { findGraphQLTemplates } from "./queryFinder"

/**
 * Semantic tokens provider for GraphQL query syntax highlighting.
 *
 * Generates semantic tokens for GraphQL elements:
 * - Functions: operation names (query/mutation/subscription), root-level entry point fields
 * - Type names: inline fragment types, fragment definitions
 * - Properties: nested field names, fragment spreads
 * - Parameters: argument names in field selections
 * - Variables: $variable references
 * - Strings/Numbers: literal values
 *
 * Unstyled: operation keywords (query, mutation, subscription)
 *
 * This provides selective highlighting to add just enough visual structure
 * without being distracting.
 */
export class GraphQLSemanticTokensProvider
  implements vscode.DocumentSemanticTokensProvider
{
  private legend: vscode.SemanticTokensLegend

  constructor() {
    // Define token types and modifiers that will be used
    const tokenTypes = [
      "keyword", // query, mutation, subscription, fragment, on
      "type", // inline fragment types, fragment definitions
      "function", // operation names, root-level entry point fields
      "property", // nested field names, fragment spreads
      "parameter", // argument names (e.g., serviceQuoteId in serviceQuoteId: $serviceQuoteId)
      "variable", // $variable
      "string", // string literals
      "number", // number literals
      "method",
    ]

    const tokenModifiers = [
      "declaration", // operation/fragment declaration
      "definition", // fragment definition
    ]

    this.legend = new vscode.SemanticTokensLegend(tokenTypes, tokenModifiers)
  }

  get semanticTokensLegend(): vscode.SemanticTokensLegend {
    return this.legend
  }

  provideDocumentSemanticTokens(
    document: vscode.TextDocument
  ): vscode.SemanticTokens {
    const builder = new vscode.SemanticTokensBuilder(this.legend)
    const text = document.getText()
    const templates = findGraphQLTemplates(text)

    for (const template of templates) {
      try {
        const doc = parse(template.query)
        this.walkDocument(doc, template, builder)
      } catch {
        // Ignore parse errors (invalid/partial queries)
        // The validator will catch these and show diagnostics
      }
    }

    return builder.build()
  }

  private walkDocument(
    doc: DocumentNode,
    template: ReturnType<typeof findGraphQLTemplates>[0],
    builder: vscode.SemanticTokensBuilder
  ): void {
    // Track depth in selection sets to distinguish root fields from nested
    let selectionSetDepth = 0
    // Track whether we're inside a fragment definition (fields should always be "property")
    let inFragmentDefinition = false

    visit(doc, {
      OperationDefinition: (node: OperationDefinitionNode) => {
        // Highlight operation name as "function" (direct entry points like mutations/queries)
        if (node.name) {
          this.addToken(
            builder,
            template,
            node.name.loc,
            node.name.value.length,
            "function",
            ["declaration"]
          )
        }
      },

      FragmentDefinition: {
        enter: (node: FragmentDefinitionNode) => {
          // Highlight "fragment" keyword
          if (node.loc) {
            const fragmentKeywordStart = node.loc.start
            this.addTokenByOffset(
              builder,
              template,
              fragmentKeywordStart,
              "fragment".length,
              "keyword",
              ["declaration"]
            )
          }

          // Highlight fragment name
          if (node.name) {
            this.addToken(
              builder,
              template,
              node.name.loc,
              node.name.value.length,
              "type",
              ["definition"]
            )
          }

          // Highlight "on" keyword before type
          if (node.typeCondition && node.typeCondition.loc) {
            const onStart = node.typeCondition.loc.start - 3 // "on " is 3 chars before type name
            this.addTokenByOffset(
              builder,
              template,
              onStart,
              "on".length,
              "keyword"
            )
          }

          // Highlight the type after "on"
          if (node.typeCondition && node.typeCondition.name) {
            this.addToken(
              builder,
              template,
              node.typeCondition.name.loc,
              node.typeCondition.name.value.length,
              "type"
            )
          }

          // Mark that we're entering a fragment definition
          inFragmentDefinition = true
        },
        leave: () => {
          // Mark that we're leaving a fragment definition
          inFragmentDefinition = false
        },
      },

      SelectionSet: {
        enter: () => {
          selectionSetDepth++
        },
        leave: () => {
          selectionSetDepth--
        },
      },

      Field: (node: FieldNode) => {
        // Inside fragment definitions, all fields should be "property"
        // Outside, root-level fields (depth 1) are "function", nested are "property"
        if (node.name) {
          if (inFragmentDefinition) {
            // All fields in fragments are properties
            this.addToken(
              builder,
              template,
              node.name.loc,
              node.name.value.length,
              "property"
            )
          } else if (selectionSetDepth === 1) {
            // Root-level fields in operations are functions
            this.addToken(
              builder,
              template,
              node.name.loc,
              node.name.value.length,
              "function"
            )
          }
          // Note: nested fields (depth > 1) in operations don't get styled
        }

        // Highlight argument names (the parameter names, not the values)
        if (node.arguments && node.arguments.length > 0) {
          for (const arg of node.arguments) {
            if (arg.name) {
              this.addToken(
                builder,
                template,
                arg.name.loc,
                arg.name.value.length,
                "parameter"
              )
            }
          }
        }
      },

      InlineFragment: (node: InlineFragmentNode) => {
        // Highlight "on" keyword before type
        if (node.typeCondition && node.typeCondition.loc) {
          const onStart = node.typeCondition.loc.start - 3 // "on " is 3 chars before type name
          this.addTokenByOffset(
            builder,
            template,
            onStart,
            "on".length,
            "keyword"
          )
        }

        // Highlight the type after "on"
        if (node.typeCondition && node.typeCondition.name) {
          this.addToken(
            builder,
            template,
            node.typeCondition.name.loc,
            node.typeCondition.name.value.length,
            "type"
          )
        }
      },

      FragmentSpread: (node: FragmentSpreadNode) => {
        // Highlight fragment name in spread as "property" (e.g., ...FragmentName)
        if (node.name) {
          this.addToken(
            builder,
            template,
            node.name.loc,
            node.name.value.length,
            "property"
          )
        }
      },

      Variable: (node: VariableNode) => {
        // Highlight entire variable including the $ prefix
        if (node.name && node.name.loc) {
          // The location includes the $, so we add 1 for it
          const start = node.name.loc.start - 1 // include the $ character
          const length = node.name.value.length + 1 // +1 for $
          this.addTokenByOffset(builder, template, start, length, "variable")
        }
      },

      StringValue: (node: any) => {
        // Highlight string literal values
        if (node.loc) {
          const length = node.value.length + 2 // +2 for quotes
          this.addTokenByOffset(
            builder,
            template,
            node.loc.start,
            length,
            "string"
          )
        }
      },

      IntValue: (node: any) => {
        // Highlight integer literal values
        if (node.loc) {
          const length = node.value.length
          this.addTokenByOffset(
            builder,
            template,
            node.loc.start,
            length,
            "number"
          )
        }
      },

      FloatValue: (node: any) => {
        // Highlight float literal values
        if (node.loc) {
          const length = node.value.length
          this.addTokenByOffset(
            builder,
            template,
            node.loc.start,
            length,
            "number"
          )
        }
      },

      BooleanValue: (node: any) => {
        // Highlight boolean literal values as keywords
        if (node.loc) {
          const length = node.value ? 4 : 5 // "true" (4) or "false" (5)
          this.addTokenByOffset(
            builder,
            template,
            node.loc.start,
            length,
            "keyword"
          )
        }
      },

      NullValue: (node: any) => {
        // Highlight null as keyword
        if (node.loc) {
          this.addTokenByOffset(
            builder,
            template,
            node.loc.start,
            "null".length,
            "keyword"
          )
        }
      },

      EnumValue: (node: any) => {
        // Highlight enum values with a distinct color (using type)
        if (node.loc) {
          const length = node.value.length
          this.addTokenByOffset(
            builder,
            template,
            node.loc.start,
            length,
            "type"
          )
        }
      },
    })
  }

  private addToken(
    builder: vscode.SemanticTokensBuilder,
    template: ReturnType<typeof findGraphQLTemplates>[0],
    loc: any,
    length: number,
    tokenType: string,
    modifiers?: string[]
  ): void {
    if (!loc || !loc.startToken) {
      return
    }

    const startOffset = loc.start
    this.addTokenByOffset(
      builder,
      template,
      startOffset,
      length,
      tokenType,
      modifiers
    )
  }

  private addTokenByOffset(
    builder: vscode.SemanticTokensBuilder,
    template: ReturnType<typeof findGraphQLTemplates>[0],
    startOffset: number,
    length: number,
    tokenType: string,
    modifiers?: string[]
  ): void {
    // Convert offset within query to document line/column
    const relPos = this.offsetToLineCol(template.query, startOffset)
    if (!relPos) {
      return
    }

    const line = template.startLine + relPos.line
    const character =
      relPos.line === 0 ? template.startColumn + relPos.column : relPos.column

    const tokenModifiers = modifiers ?? []

    try {
      builder.push(
        line,
        character,
        length,
        this.legend.tokenTypes.indexOf(tokenType),
        this.encodeModifiers(tokenModifiers)
      )
    } catch {
      // Ignore tokens that can't be added (out of bounds, etc.)
    }
  }

  private offsetToLineCol(
    text: string,
    offset: number
  ): { line: number; column: number } | null {
    if (offset < 0 || offset > text.length) {
      return null
    }

    let line = 0
    let column = 0

    for (let i = 0; i < offset; i++) {
      if (text[i] === "\n") {
        line++
        column = 0
      } else {
        column++
      }
    }

    return { line, column }
  }

  private encodeModifiers(modifiers: string[]): number {
    let bits = 0

    for (let i = 0; i < modifiers.length; i++) {
      const index = this.legend.tokenModifiers.indexOf(modifiers[i])
      if (index !== -1) {
        bits |= 1 << i
      }
    }

    return bits
  }
}
