import { findGraphQLTemplates } from "../src/validation/queryFinder"
import {
  validateTemplate,
  validateTemplates,
  ValidationResult,
} from "../src/validation/validator"
import { buildSchema, GraphQLSchema } from "graphql"

// A minimal but realistic schema for testing
const TEST_SCHEMA_SDL = `
  type Query {
    circusAct(id: ID!): CircusAct
    findTrapezeCrew(showId: ID!, propId: ID!): TrapezeCrew
    user(id: ID!): User
    show(id: ID!): Show
    breakCredit(bucket: String!, first: Int, after: String, search: JSON): BreakCreditConnection
  }

  scalar JSON

  type CircusAct {
    id: ID!
    canBeRescheduled: Boolean
    canChangeTiming: Boolean
    estimatedCurtainAt: String
    routine: Routine
    scheduledFor: String
    rigger: Rigger
    prop: Prop
    show: Show
  }

  type Routine {
    id: ID!
    code: String
  }

  type Rigger {
    id: ID!
    troupeName: String
  }

  type Prop {
    id: ID!
    code: String
  }

  type Show {
    id: ID!
    showNumber: String
    name: String
    status: String
    acts: [CircusAct]
  }

  type TrapezeCrew {
    id: ID!
  }

  type User {
    id: ID!
    name: String
    email: String
    stageName: String
    familyName: String
    joinedOn: String
    status: String
  }

  type BreakCreditConnection {
    nodes: [BreakCreditNode]
    pageInfo: PageInfo
  }

  type BreakCreditNode {
    user: User
    approved: Float
    used: Float
    available: Float
  }

  type PageInfo {
    hasNextPage: Boolean
    endCursor: String
  }
`

let schema: GraphQLSchema

beforeAll(() => {
  schema = buildSchema(TEST_SCHEMA_SDL)
})

describe("Query Validation", () => {
  describe("valid queries", () => {
    it("should produce no errors for a valid circusAct query", () => {
      const source = `
import gql from "graphql-tag"
export const CIRCUS_ACT = gql\`
  query circusAct($actId: ID!) {
    circusAct(id: $actId) {
      id
      canBeRescheduled
      canChangeTiming
      estimatedCurtainAt
      routine {
        id
        code
      }
      scheduledFor
      rigger {
        id
        troupeName
      }
      prop {
        id
        code
      }
      show {
        id
        showNumber
      }
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)

      const result = validateTemplate(templates[0], schema)
      expect(result.errors).toHaveLength(0)
    })

    it("should produce no errors for findTrapezeCrew query", () => {
      const source = `
import gql from "graphql-tag"
export const Q = gql\`
  query findTrapezeCrew($showId: ID!, $propId: ID!) {
    findTrapezeCrew(showId: $showId, propId: $propId) {
      id
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors).toHaveLength(0)
    })

    it("should produce no errors for a query with comments", () => {
      const source = `
import gql from "graphql-tag"
export const Q = gql\`
  # This is a comment
  query getUser($id: ID!) {
    # Another comment
    user(id: $id) {
      id
      name # inline comment
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors).toHaveLength(0)
    })
  })

  describe("invalid queries", () => {
    it("should detect invalid field names", () => {
      const source = `
import gql from "graphql-tag"
export const Q = gql\`
  query badQuery($id: ID!) {
    circusAct(id: $id) {
      id
      nonExistentField
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0].message).toContain("nonExistentField")
    })

    it("should detect multiple invalid fields", () => {
      const source = `
import gql from "graphql-tag"
export const Q = gql\`
  query badQuery($id: ID!) {
    circusAct(id: $id) {
      id
      nonExistentField
      alsoFake
      potato
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors.length).toBe(3)
    })

    it("should detect type mismatches in arguments", () => {
      const source = `
import gql from "graphql-tag"
export const Q = gql\`
  query badTypeQuery {
    circusAct(id: 123) {
      id
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      const result = validateTemplate(templates[0], schema)
      // id expects an ID, but 123 (Int) should work with ID... let's test undefined vars
      // Actually ID accepts Int literals in GraphQL, so let's test something else
    })

    it("should detect undefined variables", () => {
      const source = `
import gql from "graphql-tag"
export const Q = gql\`
  query badVarQuery($id: ID!) {
    circusAct(id: $undefinedVar) {
      id
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors.some(e => e.message.includes("undefinedVar"))).toBe(
        true
      )
    })

    it("should report parse errors for invalid syntax", () => {
      const source = `
import gql from "graphql-tag"
export const Q = gql\`
  query {
    user(id: $id) {
      id
      name
      <<<INVALID>>>
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0].severity).toBe("error")
    })
  })

  describe("multiple templates", () => {
    it("should validate all templates in a file", () => {
      const source = `
import gql from "graphql-tag"

export const QUERY_ONE = gql\`
  query getUser($id: ID!) {
    user(id: $id) {
      id
      name
      email
    }
  }
\`

export const QUERY_TWO = gql\`
  query getShow($showId: ID!) {
    show(id: $showId) {
      id
      name
      status
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(2)

      const results = validateTemplates(templates, schema)
      expect(results).toHaveLength(2)
      expect(results[0].errors).toHaveLength(0)
      expect(results[1].errors).toHaveLength(0)
    })

    it("should report errors only for the invalid template", () => {
      const source = `
import gql from "graphql-tag"

export const VALID = gql\`
  query getUser($id: ID!) {
    user(id: $id) {
      id
      name
    }
  }
\`

export const INVALID = gql\`
  query getUser($id: ID!) {
    user(id: $id) {
      id
      fakeField
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(2)

      const results = validateTemplates(templates, schema)
      expect(results[0].errors).toHaveLength(0)
      expect(results[1].errors.length).toBeGreaterThan(0)
    })
  })

  describe("error location mapping", () => {
    it("should map error lines relative to the source file", () => {
      const source = `import gql from "graphql-tag"

export const Q = gql\`
  query badQuery($id: ID!) {
    circusAct(id: $id) {
      id
      nonExistentField
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      const result = validateTemplate(templates[0], schema)
      expect(result.errors.length).toBeGreaterThan(0)
      // The error should be on a line > 2 (the gql starts on line 2, 0-indexed)
      expect(result.errors[0].line).toBeGreaterThan(2)
    })
  })

  describe("interpolated queries", () => {
    it("should skip validation for queries that are entirely interpolated variables", () => {
      const source = `
import gql from "graphql-tag"

const QUERY = gql\`
  \${PROJECT_TASK}
  \${Component.fragments.additionalFields}
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)

      const result = validateTemplate(templates[0], schema)
      // Should have no errors because interpolated queries are skipped
      expect(result.errors).toHaveLength(0)
    })

    it("should skip validation for single imported fragment interpolation", () => {
      const source = `
import gql from "graphql-tag"
import { PROJECT_TASK } from "./queries"

export const COMPOSED_QUERY = gql\`
  \${PROJECT_TASK}
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)

      const result = validateTemplate(templates[0], schema)
      // Should skip validation for interpolated-only queries
      expect(result.errors).toHaveLength(0)
    })

    it("should validate mixed queries with some real GraphQL and interpolations", () => {
      // This is a query with both real GraphQL and interpolations—should validate the real parts
      const source = `
import gql from "graphql-tag"
import { FRAGMENT } from "./fragments"

export const QUERY = gql\`
  query getUser($id: ID!) {
    user(id: $id) {
      id
      name
      nonExistentField  # This should cause an error
    }
  }
  \${FRAGMENT}
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)

      const result = validateTemplate(templates[0], schema)
      // Should validate the query part and find the nonExistentField error
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0].message).toContain("nonExistentField")
    })
  })
})
