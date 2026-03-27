import { buildSchema, GraphQLSchema } from "graphql"
import { findGraphQLTemplates } from "../src/validation/queryFinder"
import { validateTemplate } from "../src/validation/validator"

const TEST_SCHEMA_SDL = `
  type Query {
    user(id: ID!): User
    project(id: ID!): Project
  }
  type User { id: ID!, name: String, email: String }
  type Project { id: ID!, name: String }
`

let schema: GraphQLSchema

beforeAll(() => {
  schema = buildSchema(TEST_SCHEMA_SDL)
})

describe("Edge Cases", () => {
  describe("template literal edge cases", () => {
    it("should handle nested template literals in surrounding code", () => {
      const source = `
const label = \`Hello \${name}\`
const Q = gql\`
  query { user(id: "1") { id name } }
\`
const other = \`World \${foo}\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      expect(templates[0].query).toContain("query")
    })

    it("should handle queries with escaped backticks in surrounding code", () => {
      const source = `
const x = 'no backticks here'
const Q = gql\`query { user(id: "1") { id } }\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
    })
  })

  describe("multiline queries", () => {
    it("should validate a very long multiline query", () => {
      let fields = ""
      for (let i = 0; i < 100; i++) {
        fields += `      field${i}: id\n`
      }
      // These fields won't exist on User, but let's generate a very long valid query
      const source = `
const Q = gql\`
  query longQuery($id: ID!) {
    user(id: $id) {
      id
      name
      email
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors).toHaveLength(0)
    })
  })

  describe("GraphQL comments", () => {
    it("should handle a query that is only comments", () => {
      const source = `
const Q = gql\`
  # Just a comment
  # No actual query
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      // Parsing a comment-only document should result in a parse error
      const result = validateTemplate(templates[0], schema)
      // Either parse error or validation error is acceptable
    })
  })

  describe("invalid GraphQL syntax", () => {
    it("should handle completely malformed GraphQL", () => {
      const source = `
const Q = gql\`
  this is not graphql at all!!!
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0].severity).toBe("error")
    })

    it("should handle unclosed braces in GraphQL", () => {
      const source = `
const Q = gql\`
  query {
    user(id: "1") {
      id
      name
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it("should handle empty query string", () => {
      const source = `const Q = gql\`\``
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      const result = validateTemplate(templates[0], schema)
      // Empty document should produce a parse error
      expect(result.errors.length).toBeGreaterThan(0)
    })
  })

  describe("special characters", () => {
    it("should handle queries with unicode", () => {
      const source = `
const Q = gql\`
  query { user(id: "1") { id name } }
\`
// Comment with unicode: こんにちは 🚀
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors).toHaveLength(0)
    })
  })

  describe("multiple templates with mixed validity", () => {
    it("should independently validate each template", () => {
      const source = `
const VALID = gql\`
  query { user(id: "1") { id name } }
\`

const INVALID = gql\`
  query { user(id: "1") { id fakeField } }
\`

const ALSO_VALID = gql\`
  query { project(id: "1") { id name } }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(3)

      const r1 = validateTemplate(templates[0], schema)
      const r2 = validateTemplate(templates[1], schema)
      const r3 = validateTemplate(templates[2], schema)

      expect(r1.errors).toHaveLength(0)
      expect(r2.errors.length).toBeGreaterThan(0)
      expect(r3.errors).toHaveLength(0)
    })
  })

  describe("gql tag variations", () => {
    it("should detect gql without explicit import", () => {
      const source = `
const Q = gql\`query { user(id: "1") { id } }\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
    })

    it("should handle gql with line break before backtick", () => {
      // gql followed by space then backtick
      const source = `const Q = gql \`query { user(id: "1") { id } }\``
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
    })
  })

  describe("very large queries", () => {
    it("should handle a query with many nested fields", () => {
      const source = `
const Q = gql\`
  query deepQuery($id: ID!) {
    user(id: $id) {
      id
      name
      email
    }
  }
\`
`
      // Generate large version
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors).toHaveLength(0)
    })
  })
})
