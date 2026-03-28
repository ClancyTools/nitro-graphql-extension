import {
  buildSchema,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLString,
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLList,
} from "graphql"
import {
  GraphQLTypeHoverProvider,
  lineColToOffset,
  buildHoverContent,
  makeFileCommandLink,
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

// ---------------------------------------------------------------------------
// makeFileCommandLink
// ---------------------------------------------------------------------------

describe("makeFileCommandLink", () => {
  it("produces a command: markdown link", () => {
    const link = makeFileCommandLink("MyClass", "/path/to/file.rb")
    expect(link).toMatch(/\[`MyClass`\]\(command:vscode\.open\?/)
  })

  it("encodes the file URI in the link", () => {
    const link = makeFileCommandLink("MyClass", "/path/to/file.rb")
    expect(link).toContain("file%3A%2F%2F")
    expect(link).toContain("path%2Fto%2Ffile.rb")
  })

  it("wraps the label in backticks for inline code rendering", () => {
    const link = makeFileCommandLink("Foo::Bar::Mutation", "/a/b.rb")
    expect(link).toMatch(/\[`Foo::Bar::Mutation`\]/)
  })
})

// ---------------------------------------------------------------------------
// buildHoverContent — resolver extensions (schema with extensions)
// ---------------------------------------------------------------------------

describe("buildHoverContent — resolver extensions", () => {
  // Build a schema with extensions on the root fields using the GraphQL-JS API
  const userType = new GraphQLObjectType({
    name: "User",
    fields: { id: { type: new GraphQLNonNull(GraphQLString) } },
  })

  const schemaWithExtensions = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: {
        createUser: {
          type: userType,
          args: {
            name: { type: new GraphQLNonNull(GraphQLString) },
          },
          extensions: {
            resolverClass: "Acme::Graphql::CreateUserMutation",
            resolverFile: "/app/graphql/create_user_mutation.rb",
            access: ["private"],
          },
        },
        noResolverField: {
          type: GraphQLString,
        },
      },
    }),
  })

  it("shows resolver class in hover for root fields with extensions", () => {
    // "query { createUser(name: \"x\") { id } }"
    //          ^-- offset 8
    const query = 'query { createUser(name: "x") { id } }'
    const result = buildHoverContent(schemaWithExtensions, query, 8)
    expect(result).not.toBeNull()
    expect(result!.value).toContain("Acme::Graphql::CreateUserMutation")
  })

  it("resolver class is a clickable command link", () => {
    const query = 'query { createUser(name: "x") { id } }'
    const result = buildHoverContent(schemaWithExtensions, query, 8)
    expect(result!.value).toContain("command:vscode.open")
    expect(result!.value).toContain("create_user_mutation.rb")
  })

  it("shows access level in hover", () => {
    const query = 'query { createUser(name: "x") { id } }'
    const result = buildHoverContent(schemaWithExtensions, query, 8)
    expect(result!.value).toContain(":private")
  })

  it("shows 'Resolver:' and 'Access:' labels", () => {
    const query = 'query { createUser(name: "x") { id } }'
    const result = buildHoverContent(schemaWithExtensions, query, 8)
    expect(result!.value).toContain("Resolver:")
    expect(result!.value).toContain("Access:")
  })

  it("omits resolver section when no extensions present", () => {
    // noResolverField has no extensions
    const query = "query { noResolverField }"
    const result = buildHoverContent(schemaWithExtensions, query, 8)
    expect(result).not.toBeNull()
    expect(result!.value).not.toContain("Resolver:")
    expect(result!.value).not.toContain("Access:")
  })

  it("omits access section when access array is empty", () => {
    const noAccessType = new GraphQLObjectType({
      name: "User2",
      fields: { id: { type: GraphQLString } },
    })
    const schemaNoAccess = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          someField: {
            type: noAccessType,
            extensions: {
              resolverClass: "Acme::Resolver",
              resolverFile: "/app/resolver.rb",
              access: [],
            },
          },
        },
      }),
    })
    const query = "query { someField { id } }"
    const result = buildHoverContent(schemaNoAccess, query, 8)
    expect(result!.value).toContain("Resolver:")
    expect(result!.value).not.toContain("Access:")
  })

  it("shows resolver class as plain text when no resolverFile is present", () => {
    const noFileType = new GraphQLObjectType({
      name: "User3",
      fields: { id: { type: GraphQLString } },
    })
    const schemaNoFile = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          myField: {
            type: noFileType,
            extensions: {
              resolverClass: "Acme::MyResolver",
              access: ["public"],
            },
          },
        },
      }),
    })
    const query = "query { myField { id } }"
    const result = buildHoverContent(schemaNoFile, query, 8)
    expect(result!.value).toContain("Acme::MyResolver")
    expect(result!.value).not.toContain("command:vscode.open")
  })

  it("does not show resolver section for nested fields", () => {
    // Extensions are only relevant on root operation fields
    const query = 'query { createUser(name: "x") { id } }'
    // offset of 'id' inside nested User type
    const idOffset = query.indexOf("{ id }") + 2
    const result = buildHoverContent(schemaWithExtensions, query, idOffset)
    expect(result!.value).not.toContain("Resolver:")
  })
})

// ---------------------------------------------------------------------------
// buildHoverContent — type file links (schema with typeFileMap)
// ---------------------------------------------------------------------------

describe("buildHoverContent — type file links", () => {
  // Build a schema with custom types that have file mappings
  const warrantyItemType = new GraphQLObjectType({
    name: "WarrantyItem",
    fields: {
      id: { type: new GraphQLNonNull(GraphQLString) },
      name: { type: GraphQLString },
    },
  })

  const itemableType = new GraphQLObjectType({
    name: "Itemable",
    fields: {
      id: { type: new GraphQLNonNull(GraphQLString) },
    },
  })

  const schemaWithTypeFileMap = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: "Query",
      fields: {
        warranty: {
          type: warrantyItemType,
        },
        itemable: {
          type: itemableType,
        },
      },
    }),
    types: [warrantyItemType, itemableType],
    extensions: {
      typeFileMap: {
        WarrantyItem: "/app/graphql/types/warranty_item_type.rb",
        Itemable: "/app/graphql/types/itemable_type.rb",
      },
    },
  })

  it("shows custom type as a clickable link for root fields", () => {
    // "query { warranty }"
    //          ^-- offset 8 (warranty)
    const query = "query { warranty }"
    const result = buildHoverContent(schemaWithTypeFileMap, query, 8)
    expect(result).not.toBeNull()
    expect(result!.value).toContain("command:vscode.open")
    expect(result!.value).toContain("warranty_item_type.rb")
  })

  it("shows custom type as a clickable link for nested fields", () => {
    // "query { warranty { id } }"
    //          ^-- warranty at offset 8
    const query = "query { warranty { id } }"
    const result = buildHoverContent(schemaWithTypeFileMap, query, 8)
    expect(result).not.toBeNull()
    expect(result!.value).toContain("warranty_item_type.rb")
  })

  it("shows builtin types (String, ID, etc) without clickable links", () => {
    // String type should not have a file mapping
    const query = "query { warranty { name } }"
    // "query { warranty { ".length = 19, so 'name' starts at 19
    const result = buildHoverContent(schemaWithTypeFileMap, query, 19)
    expect(result).not.toBeNull()
    // Should show the type as code, not as a link
    expect(result!.value).toContain("String")
    // Should NOT contain a command link for String
    expect(result!.value).not.toMatch(/\[\`String\`\]\(command:/)
  })

  it("shows list types with clickable links for their base type", () => {
    const listType = new GraphQLObjectType({
      name: "Query2",
      fields: {
        items: {
          type: new GraphQLNonNull(
            new GraphQLList(new GraphQLNonNull(warrantyItemType))
          ),
        },
      },
    })
    const schemaWithList = new GraphQLSchema({
      query: listType,
      types: [warrantyItemType],
      extensions: {
        typeFileMap: {
          WarrantyItem: "/app/graphql/types/warranty_item_type.rb",
        },
      },
    })
    // "query { items }"
    //          ^-- offset 8
    const query = "query { items }"
    const result = buildHoverContent(schemaWithList, query, 8)
    expect(result).not.toBeNull()
    // The return type is [WarrantyItem!]! and should show as a link
    expect(result!.value).toContain("warranty_item_type.rb")
  })

  it("shows non-null wrapped custom types with clickable links", () => {
    const nonNullType = new GraphQLObjectType({
      name: "Query3",
      fields: {
        item: {
          type: new GraphQLNonNull(warrantyItemType),
        },
      },
    })
    const schemaWithNonNull = new GraphQLSchema({
      query: nonNullType,
      types: [warrantyItemType],
      extensions: {
        typeFileMap: {
          WarrantyItem: "/app/graphql/types/warranty_item_type.rb",
        },
      },
    })
    // "query { item }"
    //          ^-- offset 8
    const query = "query { item }"
    const result = buildHoverContent(schemaWithNonNull, query, 8)
    expect(result).not.toBeNull()
    // The return type is WarrantyItem! and should show as a link
    expect(result!.value).toContain("warranty_item_type.rb")
  })

  it("omits typeFileMap extensions when schema has no extensions", () => {
    const simpleType = new GraphQLObjectType({
      name: "Simple",
      fields: { id: { type: GraphQLString } },
    })
    const simpleSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          simple: { type: simpleType },
        },
      }),
      types: [simpleType],
    })
    const query = "query { simple }"
    const result = buildHoverContent(simpleSchema, query, 8)
    expect(result).not.toBeNull()
    // Should fall back to showing type as code without links
    expect(result!.value).toContain("Simple")
  })

  it("makes parent type in nested field hover clickable when it has a file path", () => {
    const projectComponentType = new GraphQLObjectType({
      name: "ProjectComponent",
      fields: { id: { type: GraphQLString } },
    })

    const parentType = new GraphQLObjectType({
      name: "ProposedPartChange",
      fields: {
        projectComponent: {
          type: new GraphQLNonNull(projectComponentType),
        },
      },
    })

    const schemaWithParentTypeFileMap = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          proposal: { type: parentType },
        },
      }),
      types: [parentType, projectComponentType],
      extensions: {
        typeFileMap: {
          ProposedPartChange: "/app/graphql/types/proposed_part_change_type.rb",
          ProjectComponent: "/app/graphql/types/project_component_type.rb",
        },
      },
    })

    // Hover on nested field: query { proposal { projectComponent } }
    //                                           ^-- projectComponent
    const query = "query { proposal { projectComponent } }"
    // "query { proposal { ".length = 19
    const offset = 19

    const result = buildHoverContent(schemaWithParentTypeFileMap, query, offset)
    expect(result).not.toBeNull()
    // Should contain the parent type name
    expect(result!.value).toContain("ProposedPartChange")
    // Should contain a link to the parent type file
    expect(result!.value).toContain("proposed_part_change_type.rb")
  })

  it("shows parent type as plain text when it has no file path", () => {
    const projectComponentType = new GraphQLObjectType({
      name: "ProjectComponent",
      fields: { id: { type: GraphQLString } },
    })

    const parentType = new GraphQLObjectType({
      name: "ProposedPartChange",
      fields: {
        projectComponent: {
          type: projectComponentType,
        },
      },
    })

    const schemaWithoutParentTypeFileMap = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: "Query",
        fields: {
          proposal: { type: parentType },
        },
      }),
      types: [parentType, projectComponentType],
      extensions: {
        typeFileMap: {
          // Only ProjectComponent is in the map, not ProposedPartChange
          ProjectComponent: "/app/graphql/types/project_component_type.rb",
        },
      },
    })

    const query = "query { proposal { projectComponent } }"
    const offset = 19

    const result = buildHoverContent(
      schemaWithoutParentTypeFileMap,
      query,
      offset
    )
    expect(result).not.toBeNull()
    // Should show parent type as plain text (in backticks)
    expect(result!.value).toContain("On:")
    expect(result!.value).toContain("ProposedPartChange")
    // Should NOT contain a command link to a file
    expect(result!.value).not.toContain("proposed_part_change_type.rb")
  })
})
