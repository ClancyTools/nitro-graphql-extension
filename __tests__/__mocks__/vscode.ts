// VS Code API mock for testing
const vscode = {
  languages: {
    createDiagnosticCollection: jest.fn(() => ({
      set: jest.fn(),
      delete: jest.fn(),
      clear: jest.fn(),
      dispose: jest.fn(),
    })),
    registerHoverProvider: jest.fn(() => ({ dispose: jest.fn() })),
    registerCodeActionsProvider: jest.fn(() => ({ dispose: jest.fn() })),
    getDiagnostics: jest.fn(() => []),
  },
  window: {
    createStatusBarItem: jest.fn(() => ({
      show: jest.fn(),
      hide: jest.fn(),
      dispose: jest.fn(),
      text: "",
      tooltip: "",
      command: "",
    })),
    showInformationMessage: jest.fn(),
    showWarningMessage: jest.fn(),
    showErrorMessage: jest.fn(),
  },
  workspace: {
    createFileSystemWatcher: jest.fn(() => ({
      onDidChange: jest.fn(),
      onDidCreate: jest.fn(),
      onDidDelete: jest.fn(),
      dispose: jest.fn(),
    })),
    getConfiguration: jest.fn(() => ({
      get: jest.fn((key: string, defaultValue: unknown) => defaultValue),
    })),
    onDidChangeTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidOpenTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidCloseTextDocument: jest.fn(() => ({ dispose: jest.fn() })),
    onDidChangeConfiguration: jest.fn(() => ({ dispose: jest.fn() })),
    textDocuments: [],
  },
  commands: {
    registerCommand: jest.fn(() => ({ dispose: jest.fn() })),
  },
  Uri: {
    file: (path: string) => ({
      fsPath: path,
      toString: () => `file://${path}`,
    }),
    parse: (str: string) => ({ fsPath: str, toString: () => str }),
  },
  Range: class {
    constructor(
      public startLine: number,
      public startCharacter: number,
      public endLine: number,
      public endCharacter: number
    ) {}
    contains() {
      return false
    }
  },
  Position: class {
    constructor(
      public line: number,
      public character: number
    ) {}
  },
  Diagnostic: class {
    range: any
    message: string
    severity: number
    source?: string
    constructor(range: any, message: string, severity: number) {
      this.range = range
      this.message = message
      this.severity = severity
    }
  },
  DiagnosticSeverity: {
    Error: 0,
    Warning: 1,
    Information: 2,
    Hint: 3,
  },
  StatusBarAlignment: {
    Left: 1,
    Right: 2,
  },
  CodeAction: class {
    title: string
    kind: any
    edit?: any
    diagnostics?: any[]
    isPreferred?: boolean
    constructor(title: string, kind: any) {
      this.title = title
      this.kind = kind
    }
  },
  CodeActionKind: {
    QuickFix: "quickfix",
  },
  WorkspaceEdit: class {
    private edits: any[] = []
    replace(uri: any, range: any, newText: string) {
      this.edits.push({ uri, range, newText })
    }
  },
  MarkdownString: class {
    value = ""
    isTrusted = false
    appendMarkdown(text: string) {
      this.value += text
    }
    appendText(text: string) {
      this.value += text
    }
  },
  Hover: class {
    contents: any
    constructor(contents: any) {
      this.contents = contents
    }
  },
}

module.exports = vscode
