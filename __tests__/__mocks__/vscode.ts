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
    registerCompletionItemProvider: jest.fn(() => ({ dispose: jest.fn() })),
    registerDocumentSemanticTokensProvider: jest.fn(() => ({
      dispose: jest.fn(),
    })),
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
    workspaceFolders: [
      {
        uri: { fsPath: "/test/workspace" },
        name: "test-workspace",
        index: 0,
      },
    ],
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
  SnippetString: class {
    value: string
    constructor(value: string) {
      this.value = value
    }
  },
  CompletionItemKind: {
    Text: 0,
    Method: 1,
    Function: 2,
    Constructor: 3,
    Field: 4,
    Variable: 5,
    Class: 6,
    Interface: 7,
    Module: 8,
    Property: 9,
    Unit: 10,
    Value: 11,
    Enum: 12,
    Keyword: 13,
    Snippet: 14,
    Color: 15,
    File: 16,
    Reference: 17,
    Folder: 18,
    EnumMember: 19,
    Constant: 20,
    Struct: 21,
    Event: 22,
    Operator: 23,
    TypeParameter: 24,
  },
  CompletionItem: class {
    label: string
    kind?: number
    detail?: string
    documentation?: any
    insertText?: any
    sortText?: string
    constructor(label: string, kind?: number) {
      this.label = label
      this.kind = kind
    }
  },
  CompletionList: class {
    items: any[]
    isIncomplete: boolean
    constructor(items: any[], isIncomplete = false) {
      this.items = items
      this.isIncomplete = isIncomplete
    }
  },
  SemanticTokensLegend: class {
    tokenTypes: string[]
    tokenModifiers: string[]
    constructor(tokenTypes: string[], tokenModifiers: string[] = []) {
      this.tokenTypes = tokenTypes
      this.tokenModifiers = tokenModifiers
    }
  },
  SemanticTokensBuilder: class {
    private data: number[] = []
    private legend: any
    private lastLine = 0
    private lastColumn = 0

    constructor(legend: any) {
      this.legend = legend
    }

    push(
      line: number,
      character: number,
      length: number,
      tokenType: number,
      tokenModifiers?: number
    ) {
      this.data.push(
        line - this.lastLine,
        character - (line === this.lastLine ? this.lastColumn : 0),
        length,
        tokenType,
        tokenModifiers ?? 0
      )
      this.lastLine = line
      this.lastColumn = character + length
    }

    build() {
      return {
        resultId: undefined,
        data: new Uint32Array(this.data),
      }
    }
  },
}

module.exports = vscode
