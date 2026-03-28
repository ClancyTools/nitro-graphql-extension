import { buildSchema } from "graphql"
import {
  GraphQLTypeHoverProvider,
  lineColToOffset,
  buildHoverContent,
} from "../src/validation/graphqlHoverProvider"

const vscode = require("vscode")

// ---------------------------------------------------------------------------
// Shared test schema
// ---------------------------------------------------------------------------

const TEST_SCHEMA = buildSchema(`
  """
  The root query type
  """
  type Query {
    """Fetch a user by ID"""
    user(id: ID!): User
    users: [User!]!
    post(id: ID!, published: Boolean): Post
  }

  type Mutation {
    """Create a new user"""
    createUser(name: String!, email: String!): User!
    deleteUser(id: ID!): Boolean
  }

  type Subscription {
    userCreated: User
  }

  type User {
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
  }
`)

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function mockDocument(source: string) {
  return { getText: () => source }
}

function pos(line: number, character: number) {
  return new vscode.Position(line, character)
}

// ---------------------------------------------------------------------------
// lineColToOffset
// ---------------------------------------------------------------------------

describe("lineColToOffset", () => {
  it("returns offset for single-line text at column 0", () => {
    expect(lineColToOffset("hello", 0, 0)).toBe(0)
    expect(lineColToOffset("hello", 0, 3)).toBe(3)
  })

  it("returns offset for multi-line text", () => {
    const text = "abc\ndef\nghi"
    // Line 0: "abc" (0-2), line 1: "def" (4-6), line 2: "ghi" (8-10)
    expect(lineColToOffset(text, 0, 0)).toBe(0)
    expect(lineColToOffset(text, 1, 0)).toBe(4)
    expect(lineColToOffset(text, 2, 0)).toBe(8)
    expect(lineColToOffset(text, 2, 3)).toBe(11)
  })

  it("clamps column to line length", () => {
    expect(lineColToOffset("hi", 0, 100)).toBe(2)
  })

  it("returns -1 for out-of-range line", () => {
    expect(lineColToOffset("hi", 5, 0)).toBe(-1)
    expect(lineColToOffset("hi", -1, 0)).toBe(-1)
  })
})

// ---------------------------------------------------------------------------
// buildHoverContent — unit tests
// ---------------------------------------------------------------------------

describe("buildHoverContent", () => {
  it("returns null for invalid GraphQL", () => {
    const result = buildHoverContent(TEST_SCHEMA, "not valid {{", 0)
    expect(result).toBeNull()
  })

  it("returns null when cursor is not on a field name", () => {
    const query = 'query { user(id: "1") { id } }'
    // Cursor at offset 0 (the 'q' in 'query') — not a field name
    const result = buildHoverContent(TEST_SCHEMA, query, 0)
    expect(result).toBeNull()
  })

  describe("root field hover — query", () => {
    // query { user(...) { ... } }
    //          ^--- offset of 'u' in 'user': "query { ".length = 8
    const query = 'query { user(id: "1") { id } }'
    const userOffset = 8 // index of 'u' in 'user'

    it("includes 'query' operation kind", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, userOffset)
      expect(result).not.toBeNull()
      expect(result!.value).toContain("query")
    })

    it("includes field name", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, userOffset)
      expect(result!.value).toContain("user")
    })

    it("includes return type", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, userOffset)
      expect(result!.value).toContain("Returns")
      expect(result!.value).toContain("User")
    })

    it("includes required argument", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, userOffset)
      expect(result!.value).toContain("Arguments")
      expect(result!.value).toContain("id")
      expect(result!.value).toContain("required")
    })

    it("includes field description", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, userOffset)
      expect(result!.value).toContain("Fetch a user by ID")
    })
  })

  describe("root field hover — mutation", () => {
    // mutation { createUser(name: "Alice", email: "a@b.com") { id } }
    const query =
      'mutation { createUser(name: "Alice", email: "a@b.com") { id } }'
    // "mutation { ".length = 11
    const offset = 11

    it("includes 'mutation' operation kind", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, offset)
      expect(result).not.toBeNull()
      expect(result!.value).toContain("mutation")
    })

    it("includes return type", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, offset)
      expect(result!.value).toContain("User!")
    })

    it("lists both required arguments", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, offset)
      expect(result!.value).toContain("name")
      expect(result!.value).toContain("email")
    })

    it("marks required args", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, offset)
      expect(result!.value).toMatch(/required/)
    })
  })

  describe("nested field hover", () => {
    // query { user(id: "1") { name } }
    //                         ^--- 'name' within User type
    const query = 'query { user(id: "1") { name } }'
    // "query { user(id: \"1\") { ".length = 24
    const nameOffset = 24

    it("shows field type", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, nameOffset)
      expect(result).not.toBeNull()
      expect(result!.value).toContain("Type")
      expect(result!.value).toContain("String!")
    })

    it("shows parent type", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, nameOffset)
      expect(result!.value).toContain("On")
      expect(result!.value).toContain("User")
    })

    it("shows field name", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, nameOffset)
      expect(result!.value).toContain("name")
    })
  })

  describe("nested field with list type", () => {
    // query { user(id: "1") { posts { id } } }
    //                         ^--- 'posts'
    const query = 'query { user(id: "1") { posts { id } } }'
    const postsOffset = 24

    it("shows list type notation", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, postsOffset)
      expect(result).not.toBeNull()
      expect(result!.value).toContain("[Post!]!")
    })
  })

  describe("field with optional argument and default value", () => {
    // post has `published: Boolean` (optional, no default)
    const query = 'query { post(id: "1") { title } }'
    // "query { ".length = 8, 'post' starts at 8
    const postOffset = 8

    it("does not mark optional args as required", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, postOffset)
      expect(result).not.toBeNull()
      expect(result!.value).toContain("published")
      // published is not NonNull so should not be marked required
      expect(result!.value).not.toMatch(/published.*required/)
    })
  })

  describe("subscription root field", () => {
    const query = "subscription { userCreated { id } }"
    // "subscription { ".length = 15
    const offset = 15

    it("includes 'subscription' operation kind", () => {
      const result = buildHoverContent(TEST_SCHEMA, query, offset)
      expect(result).not.toBeNull()
      expect(result!.value).toContain("subscription")
    })
  })

  it("field with no args shows no Arguments heading", () => {
    // 'id' on User has no arguments
    const query = 'query { user(id: "1") { id } }'
    const idOffset = 24
    const result = buildHoverContent(TEST_SCHEMA, query, idOffset)
    expect(result).not.toBeNull()
    expect(result!.value).not.toContain("Arguments")
  })
})

// ---------------------------------------------------------------------------
// GraphQLTypeHoverProvider — integration tests
// ---------------------------------------------------------------------------

describe("GraphQLTypeHoverProvider", () => {
  // Source positions: gql` starts at column 16 on line 0
  // Template startLine=0, startColumn=4 (after "gql`")

  const source = 'gql`query { user(id: "1") { name } }`'
  //              0123456789...
  // gql` => startColumn = 4
  // query text = 'query { user(id: "1") { name } }'
  // 'user' starts at offset 8 in query text.
  // In source: 4 + 8 = 12

  it("returns null when schema is unavailable", () => {
    const provider = new GraphQLTypeHoverProvider(() => null)
    const hover = provider.provideHover(mockDocument(source) as any, pos(0, 12))
    expect(hover).toBeNull()
  })

  it("returns null when cursor is outside any gql template", () => {
    const provider = new GraphQLTypeHoverProvider(() => TEST_SCHEMA)
    const hover = provider.provideHover(
      mockDocument(source) as any,
      pos(5, 0) // well outside the single-line template
    )
    expect(hover).toBeNull()
  })

  it("returns null when cursor is on non-field text inside template", () => {
    const provider = new GraphQLTypeHoverProvider(() => TEST_SCHEMA)
    // Cursor on 'q' in 'query' — not a field name
    const hover = provider.provideHover(
      mockDocument(source) as any,
      pos(0, 4) // offset 0 in query = 'q'
    )
    expect(hover).toBeNull()
  })

  it("returns a Hover for a query root field", () => {
    const provider = new GraphQLTypeHoverProvider(() => TEST_SCHEMA)
    // 'user' in query text is at offset 8; in source it's at col 4+8=12
    const hover = provider.provideHover(mockDocument(source) as any, pos(0, 12))
    expect(hover).not.toBeNull()
    expect((hover!.contents as any).value).toContain("user")
    expect((hover!.contents as any).value).toContain("query")
    expect((hover!.contents as any).value).toContain("User")
  })

  it("returns a Hover for a nested field", () => {
    const provider = new GraphQLTypeHoverProvider(() => TEST_SCHEMA)
    // 'name' in query text is at offset 24; in source col = 4+24=28
    const hover = provider.provideHover(mockDocument(source) as any, pos(0, 28))
    expect(hover).not.toBeNull()
    expect((hover!.contents as any).value).toContain("name")
    expect((hover!.contents as any).value).toContain("User")
  })

  it("works with multiline templates", () => {
    const multilineSource = [
      "const q = gql`",
      "  query {",
      '    user(id: "1") {',
      "      name",
      "    }",
      "  }",
      "`",
    ].join("\n")
    // 'name' is on line 3, column 6
    const provider = new GraphQLTypeHoverProvider(() => TEST_SCHEMA)
    const hover = provider.provideHover(
      mockDocument(multilineSource) as any,
      pos(3, 6)
    )
    expect(hover).not.toBeNull()
    expect((hover!.contents as any).value).toContain("name")
    expect((hover!.contents as any).value).toContain("String!")
  })

  it("returns null when cursor is before startColumn on template start line", () => {
    const provider = new GraphQLTypeHoverProvider(() => TEST_SCHEMA)
    // Cursor at col 2, before startColumn=4
    const hover = provider.provideHover(mockDocument(source) as any, pos(0, 2))
    expect(hover).toBeNull()
  })
})
