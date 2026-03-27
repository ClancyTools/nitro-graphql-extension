import * as vscode from "vscode"
import { ValidationResult, ValidationError } from "./validator"

const DIAGNOSTIC_SOURCE = "Nitro GraphQL"

export class GraphQLDiagnosticsProvider implements vscode.Disposable {
  private diagnosticCollection: vscode.DiagnosticCollection

  constructor() {
    this.diagnosticCollection =
      vscode.languages.createDiagnosticCollection("nitro-graphql")
  }

  /**
   * Update diagnostics for a document given validation results.
   */
  updateDiagnostics(uri: vscode.Uri, results: ValidationResult[]): void {
    const diagnostics: vscode.Diagnostic[] = []

    for (const result of results) {
      for (const error of result.errors) {
        const diagnostic = this.createDiagnostic(error)
        diagnostics.push(diagnostic)
      }
    }

    this.diagnosticCollection.set(uri, diagnostics)
  }

  /**
   * Clear diagnostics for a specific document.
   */
  clearDiagnostics(uri: vscode.Uri): void {
    this.diagnosticCollection.delete(uri)
  }

  /**
   * Clear all diagnostics.
   */
  clearAll(): void {
    this.diagnosticCollection.clear()
  }

  private createDiagnostic(error: ValidationError): vscode.Diagnostic {
    const startPos = new vscode.Position(error.line, error.column)
    const endPos =
      error.endLine !== undefined && error.endColumn !== undefined
        ? new vscode.Position(error.endLine, error.endColumn)
        : new vscode.Position(
            error.line,
            error.column + this.guessErrorLength(error.message)
          )

    const range = new vscode.Range(startPos, endPos)
    const severity =
      error.severity === "error"
        ? vscode.DiagnosticSeverity.Error
        : vscode.DiagnosticSeverity.Warning

    const diagnostic = new vscode.Diagnostic(range, error.message, severity)
    diagnostic.source = DIAGNOSTIC_SOURCE

    if (error.suggestions && error.suggestions.length > 0) {
      diagnostic.message += `\n\nDid you mean: ${error.suggestions.map(s => `"${s}"`).join(", ")}?`
    }

    return diagnostic
  }

  /**
   * Guess the length of the erroring token from the error message.
   * Extracts field names like: Cannot query field "xyz"
   */
  private guessErrorLength(message: string): number {
    const fieldMatch =
      message.match(/field "([^"]+)"/i) ||
      message.match(/argument "([^"]+)"/i) ||
      message.match(/variable "([^"]+)"/i) ||
      message.match(/type "([^"]+)"/i)
    if (fieldMatch) {
      return fieldMatch[1].length
    }
    return 1
  }

  dispose(): void {
    this.diagnosticCollection.dispose()
  }
}

/**
 * Hover provider that shows GraphQL validation error details on hover.
 */
export class GraphQLHoverProvider implements vscode.HoverProvider {
  private getDiagnostics: (uri: vscode.Uri) => vscode.Diagnostic[]

  constructor(getDiagnostics: (uri: vscode.Uri) => vscode.Diagnostic[]) {
    this.getDiagnostics = getDiagnostics
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.Hover | null {
    const diagnostics = this.getDiagnostics(document.uri)
    const hoveredDiags = diagnostics.filter(
      d => d.source === DIAGNOSTIC_SOURCE && d.range.contains(position)
    )

    if (hoveredDiags.length === 0) {
      return null
    }

    const contents = new vscode.MarkdownString()
    contents.isTrusted = true

    for (const diag of hoveredDiags) {
      const icon =
        diag.severity === vscode.DiagnosticSeverity.Error
          ? "$(error)"
          : "$(warning)"
      contents.appendMarkdown(`**${icon} GraphQL Validation**\n\n`)
      contents.appendMarkdown(`${diag.message}\n\n`)
    }

    return new vscode.Hover(contents)
  }
}

/**
 * Code action provider that offers quick fixes for GraphQL validation errors.
 */
export class GraphQLCodeActionProvider implements vscode.CodeActionProvider {
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = []

    for (const diagnostic of context.diagnostics) {
      if (diagnostic.source !== DIAGNOSTIC_SOURCE) {
        continue
      }

      // Extract suggestions from the diagnostic message
      const suggestionsMatch = diagnostic.message.match(/Did you mean: (.+)\?/)
      if (suggestionsMatch) {
        const suggestions = suggestionsMatch[1].match(/"([^"]+)"/g)
        if (suggestions) {
          for (const suggestion of suggestions) {
            const fieldName = suggestion.replace(/"/g, "")
            const action = new vscode.CodeAction(
              `Replace with "${fieldName}"`,
              vscode.CodeActionKind.QuickFix
            )
            action.edit = new vscode.WorkspaceEdit()
            action.edit.replace(document.uri, diagnostic.range, fieldName)
            action.diagnostics = [diagnostic]
            action.isPreferred = suggestions.indexOf(suggestion) === 0
            actions.push(action)
          }
        }
      }
    }

    return actions
  }
}
