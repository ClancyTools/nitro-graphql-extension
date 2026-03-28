import { buildSchema } from "graphql"
import {
  GraphQLCompletionProvider,
  lineColToOffset,
  repairQuery,
  getTypeContextAtOffset,
  buildCompletionItems,
} from "../src/validation/graphqlCompletionProvider"

const vscode = require("vscode")

// ---------------------------------------------------------------------------
// Shared test schema
// ---------------------------------------------------------------------------

const TEST_SCHEMA = buildSchema(`
  type Query {
    user(id: ID!): User
    users: [User!]!
    post(id: ID!, published: Boolean): Post
    search: SearchResult
  }

  type Mutation {
    createUser(name: String!, email: String!): User!
    deleteUser(id: ID!): Boolean
  }

  type User {
    """The user's unique identifier"""
    id: ID!
    name: String!
    email: String
    posts: [Post!]!
  }

  type Post {
    id: ID!
    title: String!
    body: String
    author: User!
    tags(limit: Int): [String!]
  }

  union SearchResult = User | Post

  interface Node {
    id: ID!
  }
`)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockDocument(source: string) {
  return { getText: () => source }
}

function pos(line: number, character: number) {
  return new vscode.Position(line, character)
}

// ---------------------------------------------------------------------------
// repairQuery
// ---------------------------------------------------------------------------

describe("repairQuery", () => {
  it("returns original query when already balanced", () => {
    const q = "query { user { id } }"
    const result = repairQuery(q, q.length)
    expect(result).toBe(q)
  })

  it("appends closing braces for one open brace", () => {
    const q = "query { user { "
    const result = repairQuery(q, q.length)
    expect(result).toContain("__typename")
    expect(result).toContain("}")
    // Should close 2 open braces
    expect((result.match(/}/g) || []).length).toBeGreaterThanOrEqual(2)
  })

  it("appends braces only up to atOffset", () => {
    const q = "query { user { id } } extra garbage"
    // Only count braces up to position 21 (after "query { user { id } }")
    const result = repairQuery(q, 21)
    // Nothing to repair — balanced at offset 21
    expect(result).not.toContain("}\n}")
  })
})

// ---------------------------------------------------------------------------
// getTypeContextAtOffset
// ---------------------------------------------------------------------------

describe("getTypeContextAtOffset", () => {
  it("returns null for unparseable query after repair", () => {
    const result = getTypeContextAtOffset(TEST_SCHEMA, "!@#$%^&", 5)
    expect(result).toBeNull()
  })

  it("returns Query type for cursor inside root query selection set", () => {
    const q = "query {\n  "
    const result = getTypeContextAtOffset(TEST_SCHEMA, q, q.length)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("Query")
  })

  it("returns Mutation type for cursor inside mutation selection set", () => {
    const q = "mutation {\n  "
    const result = getTypeContextAtOffset(TEST_SCHEMA, q, q.length)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("Mutation")
  })

  it("returns nested type when cursor is inside a field selection set", () => {
    const q = 'query { user(id: "1") {\n  '
    const result = getTypeContextAtOffset(TEST_SCHEMA, q, q.length)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("User")
  })

  it("returns doubly-nested type for deeper selection sets", () => {
    const q = 'query { user(id: "1") { posts {\n  '
    const result = getTypeContextAtOffset(TEST_SCHEMA, q, q.length)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("Post")
  })

  it("returns union type for a union-typed field", () => {
    const q = "query { search {\n  "
    const result = getTypeContextAtOffset(TEST_SCHEMA, q, q.length)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("SearchResult")
  })

  it("returns null when cursor is outside any selection set", () => {
    // Cursor at the very start of the query (before any braces)
    const q = "query { user { id } }"
    const result = getTypeContextAtOffset(TEST_SCHEMA, q, 0)
    expect(result).toBeNull()
  })

  it("handles unnamed/shorthand query (implicit Query)", () => {
    const q = "{\n  "
    const result = getTypeContextAtOffset(TEST_SCHEMA, q, q.length)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("Query")
  })

  it("returns type for inline fragment context", () => {
    const q = "query { search { ... on User {\n  "
    const result = getTypeContextAtOffset(TEST_SCHEMA, q, q.length)
    expect(result).not.toBeNull()
    expect(result!.name).toBe("User")
  })
})

// ---------------------------------------------------------------------------
// buildCompletionItems
// ---------------------------------------------------------------------------

describe("buildCompletionItems", () => {
  it("always includes __typename", () => {
    const queryType = TEST_SCHEMA.getQueryType()!
    const items = buildCompletionItems(queryType)
    const labels = items.map(i => i.label)
    expect(labels).toContain("__typename")
  })

  it("includes all fields for an object type", () => {
    const userType = TEST_SCHEMA.getType("User") as any
    const items = buildCompletionItems(userType)
    const labels = items.map(i => i.label)
    expect(labels).toContain("id")
    expect(labels).toContain("name")
    expect(labels).toContain("email")
    expect(labels).toContain("posts")
  })

  it("includes type detail for field items", () => {
    const userType = TEST_SCHEMA.getType("User") as any
    const items = buildCompletionItems(userType)
    const nameItem = items.find(i => i.label === "name")
    expect(nameItem).toBeDefined()
    expect(nameItem!.detail).toBe("String!")
  })

  it("provides sub-selection snippet for object-valued fields", () => {
    const userType = TEST_SCHEMA.getType("User") as any
    const items = buildCompletionItems(userType)
    const postsItem = items.find(i => i.label === "posts")
    expect(postsItem).toBeDefined()
    expect(postsItem!.insertText).toBeDefined()
    expect((postsItem!.insertText as any).value).toContain("{")
    expect((postsItem!.insertText as any).value).toContain("}")
  })

  it("provides argument snippet for fields with required args", () => {
    const queryType = TEST_SCHEMA.getQueryType()!
    const items = buildCompletionItems(queryType)
    const userItem = items.find(i => i.label === "user")
    expect(userItem).toBeDefined()
    // Should have snippet with 'id' argument placeholder
    expect(userItem!.insertText).toBeDefined()
    expect((userItem!.insertText as any).value).toContain("id:")
  })

  it("does not add argument snippet for optional-only arg fields", () => {
    const queryType = TEST_SCHEMA.getQueryType()!
    const items = buildCompletionItems(queryType)
    const usersItem = items.find(i => i.label === "users")
    // users has no args — insertText should be a sub-selection snippet or undefined
    if (usersItem?.insertText) {
      // If there's a snippet, it should be the `{ $0 }` style (no arg)
      expect((usersItem.insertText as any).value).not.toContain("()")
    }
  })

  it("includes field description in documentation", () => {
    const userType = TEST_SCHEMA.getType("User") as any
    const items = buildCompletionItems(userType)
    const idItem = items.find(i => i.label === "id")
    expect(idItem).toBeDefined()
    expect(idItem!.documentation).toBeDefined()
  })

  describe("union type completions", () => {
    it("returns inline fragment spreads for union member types", () => {
      const searchResult = TEST_SCHEMA.getType("SearchResult") as any
      const items = buildCompletionItems(searchResult)
      const labels = items.map(i => i.label)
      expect(labels).toContain("... on User")
      expect(labels).toContain("... on Post")
    })

    it("union items use Snippet kind", () => {
      const searchResult = TEST_SCHEMA.getType("SearchResult") as any
      const items = buildCompletionItems(searchResult)
      const userFrag = items.find(i => i.label === "... on User")
      expect(userFrag!.kind).toBe(vscode.CompletionItemKind.Snippet)
    })

    it("union fragment snippets include sub-selection braces", () => {
      const searchResult = TEST_SCHEMA.getType("SearchResult") as any
      const items = buildCompletionItems(searchResult)
      const userFrag = items.find(i => i.label === "... on User")
      expect((userFrag!.insertText as any).value).toContain("{")
      expect((userFrag!.insertText as any).value).toContain("}")
    })

    it("still includes __typename for union types", () => {
      const searchResult = TEST_SCHEMA.getType("SearchResult") as any
      const items = buildCompletionItems(searchResult)
      expect(items.map(i => i.label)).toContain("__typename")
    })
  })
})

// ---------------------------------------------------------------------------
// GraphQLCompletionProvider — integration tests
// ---------------------------------------------------------------------------

describe("GraphQLCompletionProvider", () => {
  it("returns null when schema is unavailable", () => {
    const provider = new GraphQLCompletionProvider(() => null)
    const items = provider.provideCompletionItems(
      mockDocument("gql`query { }`") as any,
      pos(0, 11)
    )
    expect(items).toBeNull()
  })

  it("returns null when cursor is outside any gql template", () => {
    const provider = new GraphQLCompletionProvider(() => TEST_SCHEMA)
    const items = provider.provideCompletionItems(
      mockDocument("gql`query { }`") as any,
      pos(5, 0) // far outside template
    )
    expect(items).toBeNull()
  })

  it("returns null when cursor is before startColumn on template start line", () => {
    const provider = new GraphQLCompletionProvider(() => TEST_SCHEMA)
    const items = provider.provideCompletionItems(
      mockDocument("gql`query { }`") as any,
      pos(0, 2) // before the backtick
    )
    expect(items).toBeNull()
  })

  it("returns Query fields when cursor is in root query selection", () => {
    // gql`query { ` — cursor right before closing backtick
    // startColumn = 4 (after "gql`")
    // query text = "query { "
    // cursor at source col 12 (= 4 + 8) — inside the selection set
    const source = "gql`query { `"
    const provider = new GraphQLCompletionProvider(() => TEST_SCHEMA)
    const items = provider.provideCompletionItems(
      mockDocument(source) as any,
      pos(0, 12)
    )
    expect(items).not.toBeNull()
    const labels = items!.map(i => i.label)
    expect(labels).toContain("user")
    expect(labels).toContain("users")
    expect(labels).toContain("post")
    expect(labels).toContain("__typename")
  })

  it("returns Mutation fields when cursor is in mutation selection", () => {
    const source = "gql`mutation { `"
    const provider = new GraphQLCompletionProvider(() => TEST_SCHEMA)
    const items = provider.provideCompletionItems(
      mockDocument(source) as any,
      pos(0, 15)
    )
    expect(items).not.toBeNull()
    const labels = items!.map(i => i.label)
    expect(labels).toContain("createUser")
    expect(labels).toContain("deleteUser")
  })

  it("returns User fields when cursor is nested inside user selection", () => {
    const source = 'gql`query { user(id: "1") { `'
    // "query { user(id: \"1\") { " = 26 chars; in source: 4 + 26 = 30
    const provider = new GraphQLCompletionProvider(() => TEST_SCHEMA)
    const items = provider.provideCompletionItems(
      mockDocument(source) as any,
      pos(0, 30)
    )
    expect(items).not.toBeNull()
    const labels = items!.map(i => i.label)
    expect(labels).toContain("id")
    expect(labels).toContain("name")
    expect(labels).toContain("email")
    expect(labels).toContain("posts")
  })

  it("returns union fragment spreads when cursor is in union field selection", () => {
    const source = "gql`query { search { `"
    // "query { search { " = 18 chars; in source: 4 + 18 = 22
    const provider = new GraphQLCompletionProvider(() => TEST_SCHEMA)
    const items = provider.provideCompletionItems(
      mockDocument(source) as any,
      pos(0, 22)
    )
    expect(items).not.toBeNull()
    const labels = items!.map(i => i.label)
    expect(labels).toContain("... on User")
    expect(labels).toContain("... on Post")
  })

  it("works with multiline templates", () => {
    const source = [
      "const q = gql`",
      "  query {",
      '    user(id: "1") {',
      "      ",
      "    }",
      "  }",
      "`",
    ].join("\n")
    // Cursor on line 3 (0-indexed), col 6 — inside user's selection set
    const provider = new GraphQLCompletionProvider(() => TEST_SCHEMA)
    const items = provider.provideCompletionItems(
      mockDocument(source) as any,
      pos(3, 6)
    )
    expect(items).not.toBeNull()
    const labels = items!.map(i => i.label)
    expect(labels).toContain("name")
    expect(labels).toContain("id")
  })
})
