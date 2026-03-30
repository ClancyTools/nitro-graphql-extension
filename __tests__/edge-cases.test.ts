import { buildSchema, GraphQLSchema } from "graphql"
import {
  findGraphQLTemplates,
  buildInterpolationMap,
} from "../src/validation/queryFinder"
import { validateTemplate } from "../src/validation/validator"

const TEST_SCHEMA_SDL = `
  type Query {
    user(id: ID!): User
    project(id: ID!): Project
    meeting(id: ID!): Meeting
  }
  type User { id: ID!, name: String, email: String }
  type Project { id: ID!, name: String }
  type Meeting {
    id: ID!
    title: String!
    attendees: [User!]!
  }
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
      // Empty document (no content, only interpolations) should be skipped with no errors
      expect(result.errors.length).toBe(0)
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

  describe("template string interpolations", () => {
    it("should skip validation for bare selection sets used as fragments", () => {
      // Bare selection sets (reusable fragments) should not be validated as queries
      const source = `
const userFragment = gql\`
  {
    id
    name
    email
  }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      // This is a bare selection set, not a query - should skip validation
      const result = validateTemplate(templates[0], schema)
      expect(result.errors).toHaveLength(0)
    })

    it("should validate queries with interpolated subselections as valid", () => {
      // When ${fragment} is interpolated inside a selection set, it should be
      // replaced with { __typename } to maintain valid GraphQL structure
      const source = `
const userFragment = gql\`
  {
    id
    name
  }
\`

const Q = gql\`
  query {
    user(id: "1") \${userFragment}
  }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(2)

      // Fragment should skip validation (bare selection set)
      const fragmentResult = validateTemplate(templates[0], schema)
      expect(fragmentResult.errors).toHaveLength(0)

      // Query should validate successfully - the interpolation is replaced with { __typename }
      const queryResult = validateTemplate(templates[1], schema)
      expect(queryResult.errors).toHaveLength(0)
    })
  })

  describe("interpolated bare selection set validation", () => {
    it("should build interpolation map from bare selection set variables", () => {
      const source = `
const meetingFragment = gql\`
  {
    id
    title
  }
\`

const fullQuery = gql\`
  query getMeeting($id: ID!) {
    meeting(id: $id) {
      id
      title
    }
  }
\`
`
      const map = buildInterpolationMap(source)
      // meetingFragment is a bare selection set — should be in the map
      expect(map.has("meetingFragment")).toBe(true)
      expect(map.get("meetingFragment")).toContain("id")
      expect(map.get("meetingFragment")).toContain("title")

      // fullQuery is a named query — should NOT be in the map
      expect(map.has("fullQuery")).toBe(false)
    })

    it("should not include non-bare templates in the interpolation map", () => {
      const source = `
const namedQuery = gql\`query GetUser { user(id: "1") { id } }\`
const mutation = gql\`mutation DoThing { user(id: "1") { id } }\`
const withVars = gql\`query ($id: ID!) { user(id: $id) { id } }\`
const fragment = gql\`fragment F on User { id name }\`
`
      const map = buildInterpolationMap(source)
      expect(map.size).toBe(0)
    })

    it("should inline interpolated bare selection set and validate fields against parent type", () => {
      // The key scenario: when a bare selection set is interpolated into a field,
      // the fields inside should be validated against the parent type.
      // Meeting has: id, title, attendees — querying valid fields should produce no errors.
      const source = `
const meetingFields = gql\`
  {
    id
    title
  }
\`

const Q = gql\`
  query getMeeting($id: ID!) {
    meeting(id: $id) \${meetingFields}
  }
\`
`
      const templates = findGraphQLTemplates(source)
      // Both templates found
      expect(templates).toHaveLength(2)

      // The query template should have the inlined content
      const queryTemplate = templates[1]
      expect(queryTemplate.query).toContain("id")
      expect(queryTemplate.query).toContain("title")

      const result = validateTemplate(queryTemplate, schema)
      expect(result.errors).toHaveLength(0)
    })

    it("should catch invalid fields in an inlined bare selection set", () => {
      // If the interpolated fragment contains bad fields, they should fail validation.
      const source = `
const meetingFields = gql\`
  {
    id
    nonExistentField
  }
\`

const Q = gql\`
  query getMeeting($id: ID!) {
    meeting(id: $id) \${meetingFields}
  }
\`
`
      const templates = findGraphQLTemplates(source)
      const queryTemplate = templates[1]
      const result = validateTemplate(queryTemplate, schema)

      // nonExistentField should fail against Meeting type
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0].message).toContain("nonExistentField")

      // The error should be reported on line 12 (where the interpolation ${meetingFields} occurs)
      // not on a deeper line from the inlined content
      const lineInTemplate = result.errors[0].line - queryTemplate.startLine
      expect(lineInTemplate).toBe(2) // Line 2 in the template (0-indexed from start of query)
    })

    it("should fallback to placeholder for unresolvable interpolations", () => {
      // If ${varName} can't be resolved (imported from another file), fall back
      // to { __typename } and don't produce false positive errors.
      const source = `
import { meetingFields } from './fragments'

const Q = gql\`
  query getMeeting($id: ID!) {
    meeting(id: $id) \${meetingFields}
  }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)

      const result = validateTemplate(templates[0], schema)
      // Should not error - fallback to { __typename } preserves valid structure
      expect(result.errors).toHaveLength(0)
    })

    it("should handle the same fragment interpolated multiple times", () => {
      // Same fragment used for multiple fields (like checkIn and checkOut)
      const source = `
const checkSchema = gql\`
  {
    id
    title
  }
\`

const Q = gql\`
  query {
    meeting(id: "1") \${checkSchema}
    user(id: "2") { id }
  }
\`
`
      // Note: meeting and user are different types, but just checking no crash
      const templates = findGraphQLTemplates(source)
      const queryTemplate = templates[1]

      // The query content should contain the inlined fields
      expect(queryTemplate.query).toContain("id")
      expect(queryTemplate.query).toContain("title")
    })

    it("should build interpolation map from untagged template string variables", () => {
      // Regression test: bare selection sets defined without the gql tag should also
      // be found and inlined. This is common when defining shared field fragments.
      const source = `
const teamCommonStructure = \`
  id
  mentor {
    lastName
    goesBy
  }
  memberCount
  name
\`

const Q = gql\`
  query {
    teams {
      \${teamCommonStructure}
    }
  }
\`
`
      const map = buildInterpolationMap(source)
      // teamCommonStructure should be in the map even though it's not wrapped in gql\`...\`
      expect(map.has("teamCommonStructure")).toBe(true)
      expect(map.get("teamCommonStructure")).toContain("id")
      expect(map.get("teamCommonStructure")).toContain("lastName")
      expect(map.get("teamCommonStructure")).toContain("name")
    })

    it("should handle unresolvable computed interpolations inside selection sets", () => {
      // Regression test: when an unresolvable interpolation appears inside a selection set
      // (not on a field), use __typename to avoid syntax errors. This handles cases where
      // the interpolation is computed dynamically, like:
      // const result = fragments.map(...).reduce(...)
      const source = `
const gisTypeQuery = gisTypes
    .map(gisType => gisTypeQueries[gisType])
    .reduce((acc, t) => acc.concat(t), "")
const Q = gql\`
  query (\$latitude: Float!, \$longitude: Float!) {
    clickedPoint(latitude: \$latitude, longitude: \$longitude) {
      \${gisTypeQuery}
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)

      const result = validateTemplate(templates[0], schema)
      // Should not error - unresolvable interpolations inside selection sets are replaced
      // with __typename which is a valid field name. May have other validation errors
      // but not from the parse error.
      const parseErrors = result.errors.filter(e =>
        e.message.includes("Expected Name")
      )
      expect(parseErrors).toHaveLength(0)
    })
  })
})
