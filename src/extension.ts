import * as vscode from "vscode"
import * as logger from "./outputChannel"
import { SchemaManager } from "./schema/schemaManager"
import { CacheManager } from "./cache/cacheManager"
import { findGraphQLTemplates } from "./validation/queryFinder"
import { validateTemplates } from "./validation/validator"
import {
  GraphQLDiagnosticsProvider,
  GraphQLHoverProvider,
  GraphQLCodeActionProvider,
} from "./validation/diagnostics"
import { FileWatcher } from "./watcher/fileWatcher"
import { GraphQLTypeHoverProvider } from "./validation/graphqlHoverProvider"
import { GraphQLCompletionProvider } from "./validation/graphqlCompletionProvider"
import { GraphQLSemanticTokensProvider } from "./validation/graphqlSemanticTokensProvider"

let schemaManager: SchemaManager | undefined
let diagnosticsProvider: GraphQLDiagnosticsProvider | undefined
let fileWatcher: FileWatcher | undefined
let statusBarItem: vscode.StatusBarItem | undefined
let cacheManager: CacheManager | undefined
let validationDebounceTimers: Map<
  string,
  ReturnType<typeof setTimeout>
> = new Map()

const SUPPORTED_LANGUAGES = [
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
]

export function activate(context: vscode.ExtensionContext): void {
  logger.initOutputChannel(context)
  logger.log("[NitroGraphQL] Extension activating...")

  const config = vscode.workspace.getConfiguration("nitroGraphql")
  if (!config.get<boolean>("enabled", true)) {
    logger.log("[NitroGraphQL] Extension disabled via settings.")
    return
  }

  // Determine workspace root (where Ruby GraphQL files live)
  const workspaceFolders = vscode.workspace.workspaceFolders
  if (!workspaceFolders || workspaceFolders.length === 0) {
    logger.warn("[NitroGraphQL] No workspace folder open.")
    return
  }
  const basePath = workspaceFolders[0].uri.fsPath

  // Initialize components
  cacheManager = new CacheManager()
  diagnosticsProvider = new GraphQLDiagnosticsProvider()

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  )
  statusBarItem.command = "nitroGraphql.showSchemaStatus"
  statusBarItem.text = "$(sync~spin) GraphQL: Loading..."
  statusBarItem.show()

  // Schema manager — builds schema from local Ruby files
  schemaManager = new SchemaManager(basePath, cacheManager, {
    onStatusChange: info => {
      if (!statusBarItem) {
        return
      }
      switch (info.status) {
        case "loading":
          statusBarItem.text = "$(sync~spin) GraphQL: Loading..."
          statusBarItem.tooltip = info.message
          break
        case "ready":
          statusBarItem.text = "$(check) GraphQL: Ready"
          statusBarItem.tooltip = info.message
          break
        case "cached":
          statusBarItem.text = "$(database) GraphQL: Cached"
          statusBarItem.tooltip = info.message
          break
        case "error":
          statusBarItem.text = "$(error) GraphQL: Error"
          statusBarItem.tooltip = info.message
          break
        default:
          statusBarItem.text = "$(circle-outline) GraphQL: Idle"
      }
    },
    onSchemaReady: () => {
      // Re-validate all open documents when schema changes
      revalidateAllOpenDocuments()
    },
  })

  // Register providers
  const diagnosticCollection = diagnosticsProvider
  context.subscriptions.push(diagnosticCollection)

  // Hover provider
  const hoverProvider = new GraphQLHoverProvider(uri => {
    return vscode.languages
      .getDiagnostics(uri)
      .filter(d => d.source === "Nitro GraphQL")
  })
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(SUPPORTED_LANGUAGES, hoverProvider)
  )

  // GraphQL type info hover provider (shows field/arg types on hover)
  const typeHoverProvider = new GraphQLTypeHoverProvider(
    () => schemaManager?.getSchema() ?? null
  )
  context.subscriptions.push(
    vscode.languages.registerHoverProvider(
      SUPPORTED_LANGUAGES,
      typeHoverProvider
    )
  )

  // GraphQL completion provider (suggests fields as the user types)
  const completionProvider = new GraphQLCompletionProvider(
    () => schemaManager?.getSchema() ?? null
  )
  context.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(
      SUPPORTED_LANGUAGES,
      completionProvider,
      " ",
      "\n",
      "{"
    )
  )

  // Code action provider
  const codeActionProvider = new GraphQLCodeActionProvider()
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      SUPPORTED_LANGUAGES,
      codeActionProvider,
      {
        providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
      }
    )
  )

  // Semantic tokens provider (syntax highlighting)
  const semanticTokensProvider = new GraphQLSemanticTokensProvider()
  context.subscriptions.push(
    vscode.languages.registerDocumentSemanticTokensProvider(
      SUPPORTED_LANGUAGES,
      semanticTokensProvider,
      semanticTokensProvider.semanticTokensLegend
    )
  )

  // File watcher — watches TS/JS for query changes and .rb for schema changes
  fileWatcher = new FileWatcher({
    onQueryFileChanged: uri => {
      const doc = vscode.workspace.textDocuments.find(
        d => d.uri.fsPath === uri.fsPath
      )
      if (doc) {
        validateDocument(doc)
      }
    },
    onSchemaFileChanged: () => {
      logger.log(
        "[NitroGraphQL] GraphQL Ruby file changed, rebuilding schema..."
      )
      schemaManager?.refresh()
    },
  })
  context.subscriptions.push(fileWatcher)

  // Document change listener with debouncing
  const validationDebounce = config.get<number>("validationDebounce", 300)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      if (!SUPPORTED_LANGUAGES.includes(event.document.languageId)) {
        return
      }
      debouncedValidate(event.document, validationDebounce)
    })
  )

  // Validate on document open
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(document => {
      if (SUPPORTED_LANGUAGES.includes(document.languageId)) {
        validateDocument(document)
      }
    })
  )

  // Clear diagnostics on close
  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(document => {
      diagnosticsProvider?.clearDiagnostics(document.uri)
    })
  )

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("nitroGraphql.refreshSchema", async () => {
      await schemaManager?.refresh()
      vscode.window.showInformationMessage("GraphQL schema rebuilt.")
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("nitroGraphql.clearCache", async () => {
      await cacheManager?.clearAll()
      vscode.window.showInformationMessage("GraphQL schema cache cleared.")
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("nitroGraphql.showSchemaStatus", () => {
      const info = schemaManager?.getStatus()
      if (info) {
        vscode.window.showInformationMessage(
          `GraphQL Schema: ${info.status} — ${info.message}`
        )
      }
    })
  )

  context.subscriptions.push(
    vscode.commands.registerCommand("nitroGraphql.showLogs", () => {
      logger.showChannel()
    })
  )

  context.subscriptions.push({ dispose: () => statusBarItem?.dispose() })
  context.subscriptions.push({ dispose: () => schemaManager?.dispose() })

  // Start building schema from Ruby files
  schemaManager.initialize()

  // Validate already-open documents
  for (const doc of vscode.workspace.textDocuments) {
    if (SUPPORTED_LANGUAGES.includes(doc.languageId)) {
      validateDocument(doc)
    }
  }

  logger.log("[NitroGraphQL] Extension activated.")
}

function validateDocument(document: vscode.TextDocument): void {
  if (!schemaManager || !diagnosticsProvider) {
    return
  }

  const schema = schemaManager.getSchema()
  if (!schema) {
    return // Schema not loaded yet
  }

  const text = document.getText()
  const templates = findGraphQLTemplates(text)

  if (templates.length === 0) {
    diagnosticsProvider.clearDiagnostics(document.uri)
    return
  }

  const results = validateTemplates(templates, schema, cacheManager)
  diagnosticsProvider.updateDiagnostics(document.uri, results)
}

function debouncedValidate(
  document: vscode.TextDocument,
  delayMs: number
): void {
  const key = document.uri.fsPath
  const existing = validationDebounceTimers.get(key)
  if (existing) {
    clearTimeout(existing)
  }
  validationDebounceTimers.set(
    key,
    setTimeout(() => {
      validationDebounceTimers.delete(key)
      validateDocument(document)
    }, delayMs)
  )
}

function revalidateAllOpenDocuments(): void {
  for (const doc of vscode.workspace.textDocuments) {
    if (SUPPORTED_LANGUAGES.includes(doc.languageId)) {
      validateDocument(doc)
    }
  }
}

export function deactivate(): void {
  logger.log("[NitroGraphQL] Extension deactivating...")
  for (const timer of validationDebounceTimers.values()) {
    clearTimeout(timer)
  }
  validationDebounceTimers.clear()
}
