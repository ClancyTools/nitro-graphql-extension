import {
  GraphQLDiagnosticsProvider,
  GraphQLCodeActionProvider,
} from "../src/validation/diagnostics"
import { ValidationResult, ValidationError } from "../src/validation/validator"
import {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLField,
  GraphQLString,
} from "graphql"

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

  it("should provide type view actions when schema contains the type", () => {
    // Create a mock schema with a User type
    const userType = new GraphQLObjectType({
      name: "User",
      fields: {
        id: { type: GraphQLString },
        name: { type: GraphQLString },
      },
    })

    const schema = new GraphQLSchema({
      query: userType,
    })

    const providerWithSchema = new GraphQLCodeActionProvider(() => schema)

    const document = { uri: { fsPath: "/test.ts" } } as any
    const range = {} as any
    const context = {
      diagnostics: [
        {
          source: "Nitro GraphQL",
          message: 'Cannot query field "fakeField" on type "User".',
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 13 },
          },
        },
      ],
    } as any

    const actions = providerWithSchema.provideCodeActions(
      document,
      range,
      context
    )
    // Should have at least one "View type" action
    const typeActions = actions.filter(a =>
      a.title.includes('View type "User"')
    )
    expect(typeActions.length).toBe(1)
    expect(typeActions[0].command?.command).toBe(
      "nitroGraphql.viewTypeDefinition"
    )
    expect(typeActions[0].command?.arguments).toEqual(["User"])
  })

  it("should not provide type view actions when schema is null", () => {
    const providerWithoutSchema = new GraphQLCodeActionProvider(() => null)

    const document = { uri: { fsPath: "/test.ts" } } as any
    const range = {} as any
    const context = {
      diagnostics: [
        {
          source: "Nitro GraphQL",
          message: 'Cannot query field "fakeField" on type "User".',
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 13 },
          },
        },
      ],
    } as any

    const actions = providerWithoutSchema.provideCodeActions(
      document,
      range,
      context
    )
    // Should have no "View type" actions
    const typeActions = actions.filter(a => a.title.includes("View type"))
    expect(typeActions.length).toBe(0)
  })

  it("should not provide type view actions when type is not in schema", () => {
    // Create a mock schema with only a User type
    const userType = new GraphQLObjectType({
      name: "User",
      fields: {
        id: { type: GraphQLString },
      },
    })

    const schema = new GraphQLSchema({
      query: userType,
    })

    const providerWithSchema = new GraphQLCodeActionProvider(() => schema)

    const document = { uri: { fsPath: "/test.ts" } } as any
    const range = {} as any
    const context = {
      diagnostics: [
        {
          source: "Nitro GraphQL",
          message: 'Cannot query field "fakeField" on type "NonExistentType".',
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 13 },
          },
        },
      ],
    } as any

    const actions = providerWithSchema.provideCodeActions(
      document,
      range,
      context
    )
    // Should have no "View type" actions for non-existent type
    const typeActions = actions.filter(a => a.title.includes("View type"))
    expect(typeActions.length).toBe(0)
  })

  it("should extract multiple type names from error message", () => {
    // Create a mock schema with two types
    const userType = new GraphQLObjectType({
      name: "User",
      fields: { id: { type: GraphQLString } },
    })

    const proposalType = new GraphQLObjectType({
      name: "Proposal",
      fields: { id: { type: GraphQLString } },
    })

    // Create a schema that can return both types
    const schema = new GraphQLSchema({
      query: userType,
    })
    const originalGetType = schema.getType.bind(schema)
    schema.getType = jest.fn((name: string) => {
      if (name === "User") return userType
      if (name === "Proposal") return proposalType
      return originalGetType(name)
    })

    const providerWithSchema = new GraphQLCodeActionProvider(() => schema)

    const document = { uri: { fsPath: "/test.ts" } } as any
    const range = {} as any
    // Error message with two type references
    const context = {
      diagnostics: [
        {
          source: "Nitro GraphQL",
          message:
            'Cannot query field "xyz" on type "User", did you mean on type "Proposal"?',
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 7 },
          },
        },
      ],
    } as any

    const actions = providerWithSchema.provideCodeActions(
      document,
      range,
      context
    )
    // Should have 2 "View type" actions
    const typeActions = actions.filter(a => a.title.includes("View type"))
    expect(typeActions.length).toBe(2)
    expect(typeActions.some(a => a.title.includes("User"))).toBe(true)
    expect(typeActions.some(a => a.title.includes("Proposal"))).toBe(true)
  })

  it("should combine suggestions and type view actions", () => {
    const userType = new GraphQLObjectType({
      name: "User",
      fields: {
        id: { type: GraphQLString },
        name: { type: GraphQLString },
      },
    })

    const schema = new GraphQLSchema({
      query: userType,
    })

    const providerWithSchema = new GraphQLCodeActionProvider(() => schema)

    const document = { uri: { fsPath: "/test.ts" } } as any
    const range = {} as any
    const context = {
      diagnostics: [
        {
          source: "Nitro GraphQL",
          message:
            'Cannot query field "naem" on type "User". Did you mean: "name"?',
          range: {
            start: { line: 1, character: 4 },
            end: { line: 1, character: 8 },
          },
        },
      ],
    } as any

    const actions = providerWithSchema.provideCodeActions(
      document,
      range,
      context
    )
    // Should have 1 suggestion + 1 type view action
    expect(actions.length).toBe(2)
    const replacementAction = actions.find(a => a.title.includes("Replace"))
    const typeAction = actions.find(a => a.title.includes("View type"))
    expect(replacementAction).toBeDefined()
    expect(typeAction).toBeDefined()
  })
})
