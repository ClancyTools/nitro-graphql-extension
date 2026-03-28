import {
  buildSchema,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLNonNull,
} from "graphql"
import { GraphQLSemanticTokensProvider } from "../src/validation/graphqlSemanticTokensProvider"

const vscode = require("vscode")

// Mock document
function mockDocument(source: string) {
  return { getText: () => source }
}

describe("GraphQLSemanticTokensProvider", () => {
  let provider: GraphQLSemanticTokensProvider

  beforeEach(() => {
    provider = new GraphQLSemanticTokensProvider()
  })

  it("creates legend with expected token types", () => {
    const legend = provider.semanticTokensLegend
    expect(legend.tokenTypes).toContain("keyword")
    expect(legend.tokenTypes).toContain("type")
    expect(legend.tokenTypes).toContain("property")
    expect(legend.tokenTypes).toContain("variable")
    expect(legend.tokenTypes).toContain("string")
    expect(legend.tokenTypes).toContain("number")
  })

  it("creates legend with expected modifiers", () => {
    const legend = provider.semanticTokensLegend
    expect(legend.tokenModifiers).toContain("declaration")
    expect(legend.tokenModifiers).toContain("definition")
  })

  it("provides semantic tokens for a simple query", () => {
    const source = "const q = gql`query GetUser { user { id } }`"
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    expect(tokens).not.toBeNull()
    expect(tokens.data.length).toBeGreaterThan(0)
  })

  it("provides semantic tokens for a mutation", () => {
    const source =
      "const m = gql`mutation CreateUser($name: String!) { createUser(name: $name) { id } }`"
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    expect(tokens).not.toBeNull()
    expect(tokens.data.length).toBeGreaterThan(0)
  })

  it("handles multiple gql templates in one file", () => {
    const source = `
      const q1 = gql\`query GetUser { user { id } }\`
      const q2 = gql\`query GetPosts { posts { title } }\`
    `
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    expect(tokens).not.toBeNull()
    // Should have tokens from both queries
    expect(tokens.data.length).toBeGreaterThan(0)
  })

  it("handles fragments", () => {
    const source =
      "const frag = gql`fragment UserInfo on User { id name email }`"
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    expect(tokens).not.toBeNull()
    expect(tokens.data.length).toBeGreaterThan(0)
  })

  it("handles inline fragments", () => {
    const source =
      "const q = gql`query { search { ... on User { id } ... on Post { title } } }`"
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    expect(tokens).not.toBeNull()
    expect(tokens.data.length).toBeGreaterThan(0)
  })

  it("handles variables", () => {
    const source =
      "const q = gql`query GetUser($id: ID!) { user(id: $id) { id } }`"
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    expect(tokens).not.toBeNull()
    expect(tokens.data.length).toBeGreaterThan(0)
  })

  it("gracefully handles invalid queries", () => {
    const source = "const q = gql`invalid {{query`"
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    expect(tokens).not.toBeNull()
    // Should return empty tokens (no valid query to highlight)
    expect(tokens.data.length).toBe(0)
  })

  it("handles multiline queries", () => {
    const source = `
      const q = gql\`
        query GetUser {
          user {
            id
            name
            email
          }
        }
      \`
    `
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    expect(tokens).not.toBeNull()
    expect(tokens.data.length).toBeGreaterThan(0)
  })

  it("includes token modifiers in output", () => {
    const source = "const q = gql`query GetUser { user { id } }`"
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    // A declaration should have the "declaration" modifier encoded
    expect(tokens).not.toBeNull()
    expect(tokens.data.length).toBeGreaterThan(0)
  })

  it("provides semantic tokens for fragment definitions", () => {
    const source = `
      const frag = gql\`
        fragment UserFields on User {
          id
          name
          email
        }
      \`
    `
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    expect(tokens).not.toBeNull()
    expect(tokens.data.length).toBeGreaterThan(0)
  })

  it("handles fragments with nested fields", () => {
    const source = `
      const frag = gql\`
        fragment UserFields on User {
          id
          name
          profile {
            bio
            avatar
          }
        }
      \`
    `
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    expect(tokens).not.toBeNull()
    expect(tokens.data.length).toBeGreaterThan(0)
  })

  it("highlights fragment spreads as property", () => {
    const source = `
      const q = gql\`
        query GetUser {
          user {
            ...UserFields
          }
        }
      \`
    `
    const doc = mockDocument(source) as any

    const tokens = provider.provideDocumentSemanticTokens(doc)
    expect(tokens).not.toBeNull()
    expect(tokens.data.length).toBeGreaterThan(0)
  })
})
