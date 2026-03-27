import {
  GraphQLDiagnosticsProvider,
  GraphQLCodeActionProvider,
} from "../src/validation/diagnostics"
import { ValidationResult, ValidationError } from "../src/validation/validator"

describe("GraphQLDiagnosticsProvider", () => {
  let provider: GraphQLDiagnosticsProvider

  beforeEach(() => {
    provider = new GraphQLDiagnosticsProvider()
  })

  afterEach(() => {
    provider.dispose()
  })

  it("should create without errors", () => {
    expect(provider).toBeDefined()
  })

  it("should update diagnostics for a document", () => {
    const uri = {
      fsPath: "/test/file.ts",
      toString: () => "file:///test/file.ts",
    } as any
    const results: ValidationResult[] = [
      {
        template: {
          query: "query { user { id } }",
          startLine: 5,
          startColumn: 0,
          rawMatch: "gql`query { user { id } }`",
        },
        errors: [
          {
            message: 'Cannot query field "fakeField" on type "User".',
            line: 6,
            column: 4,
            severity: "error",
          },
        ],
      },
    ]

    // Should not throw
    provider.updateDiagnostics(uri, results)
  })

  it("should clear diagnostics for a document", () => {
    const uri = {
      fsPath: "/test/file.ts",
      toString: () => "file:///test/file.ts",
    } as any
    provider.clearDiagnostics(uri)
    // Should not throw
  })

  it("should clear all diagnostics", () => {
    provider.clearAll()
    // Should not throw
  })

  it("should handle results with no errors", () => {
    const uri = {
      fsPath: "/test/file.ts",
      toString: () => "file:///test/file.ts",
    } as any
    const results: ValidationResult[] = [
      {
        template: {
          query: "query { user { id } }",
          startLine: 0,
          startColumn: 0,
          rawMatch: "gql`query { user { id } }`",
        },
        errors: [],
      },
    ]
    provider.updateDiagnostics(uri, results)
  })

  it("should handle results with suggestions", () => {
    const uri = {
      fsPath: "/test/file.ts",
      toString: () => "file:///test/file.ts",
    } as any
    const results: ValidationResult[] = [
      {
        template: {
          query: "query { user { id } }",
          startLine: 0,
          startColumn: 0,
          rawMatch: "gql`query { user { id } }`",
        },
        errors: [
          {
            message: 'Cannot query field "naem" on type "User".',
            line: 1,
            column: 4,
            severity: "error",
            suggestions: ["name"],
          },
        ],
      },
    ]
    provider.updateDiagnostics(uri, results)
  })

  it("should handle multiple errors in one file", () => {
    const uri = {
      fsPath: "/test/file.ts",
      toString: () => "file:///test/file.ts",
    } as any
    const results: ValidationResult[] = [
      {
        template: {
          query: "query { user { id fakeField } }",
          startLine: 0,
          startColumn: 0,
          rawMatch: "gql`...`",
        },
        errors: [
          {
            message: "Error 1",
            line: 1,
            column: 4,
            severity: "error",
          },
          {
            message: "Error 2",
            line: 2,
            column: 8,
            severity: "warning",
          },
        ],
      },
    ]
    provider.updateDiagnostics(uri, results)
  })
})

describe("GraphQLCodeActionProvider", () => {
  let provider: GraphQLCodeActionProvider

  beforeEach(() => {
    provider = new GraphQLCodeActionProvider()
  })

  it("should return empty array for non-GraphQL diagnostics", () => {
    const document = { uri: { fsPath: "/test.ts" } } as any
    const range = {} as any
    const context = {
      diagnostics: [{ source: "typescript", message: "some error", range: {} }],
    } as any

    const actions = provider.provideCodeActions(document, range, context)
    expect(actions).toHaveLength(0)
  })

  it("should provide quick fixes when suggestions are available", () => {
    const document = { uri: { fsPath: "/test.ts" } } as any
    const range = {} as any
    const context = {
      diagnostics: [
        {
          source: "Nitro GraphQL",
          message: 'Cannot query field "naem". Did you mean: "name", "email"?',
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 8 },
          },
        },
      ],
    } as any

    const actions = provider.provideCodeActions(document, range, context)
    expect(actions.length).toBe(2)
    expect(actions[0].title).toContain("name")
    expect(actions[1].title).toContain("email")
  })
})
