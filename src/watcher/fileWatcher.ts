import * as vscode from "vscode"

export interface FileWatcherCallbacks {
  onQueryFileChanged: (uri: vscode.Uri) => void
  onSchemaFileChanged: (uri: vscode.Uri) => void
}

export class FileWatcher implements vscode.Disposable {
  private watchers: vscode.FileSystemWatcher[] = []
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
  private queryDebounceMs: number
  private schemaDebounceMs: number

  constructor(
    callbacks: FileWatcherCallbacks,
    queryDebounceMs = 100,
    schemaDebounceMs = 100
  ) {
    this.queryDebounceMs = queryDebounceMs
    this.schemaDebounceMs = schemaDebounceMs

    // Watch TypeScript/JavaScript files for query changes
    const queryPatterns = ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx"]

    for (const pattern of queryPatterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern)
      watcher.onDidChange(uri =>
        this.debounce(
          `query:${uri.fsPath}`,
          () => callbacks.onQueryFileChanged(uri),
          this.queryDebounceMs
        )
      )
      watcher.onDidCreate(uri =>
        this.debounce(
          `query:${uri.fsPath}`,
          () => callbacks.onQueryFileChanged(uri),
          this.queryDebounceMs
        )
      )
      this.watchers.push(watcher)
    }

    // Watch Ruby GraphQL definition files for schema changes
    const schemaPattern = "**/components/*/app/graphql/**/*.rb"
    const schemaWatcher =
      vscode.workspace.createFileSystemWatcher(schemaPattern)
    schemaWatcher.onDidChange(uri =>
      this.debounce(
        "schema",
        () => callbacks.onSchemaFileChanged(uri),
        this.schemaDebounceMs
      )
    )
    schemaWatcher.onDidCreate(uri =>
      this.debounce(
        "schema",
        () => callbacks.onSchemaFileChanged(uri),
        this.schemaDebounceMs
      )
    )
    schemaWatcher.onDidDelete(uri =>
      this.debounce(
        "schema",
        () => callbacks.onSchemaFileChanged(uri),
        this.schemaDebounceMs
      )
    )
    this.watchers.push(schemaWatcher)
  }

  private debounce(key: string, callback: () => void, delayMs: number): void {
    const existing = this.debounceTimers.get(key)
    if (existing) {
      clearTimeout(existing)
    }
    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key)
        callback()
      }, delayMs)
    )
  }

  dispose(): void {
    for (const watcher of this.watchers) {
      watcher.dispose()
    }
    this.watchers = []
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer)
    }
    this.debounceTimers.clear()
  }
}
