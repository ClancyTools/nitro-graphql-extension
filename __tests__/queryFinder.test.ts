import {
  findGraphQLTemplates,
  GraphQLTemplateInfo,
} from "../src/validation/queryFinder"

describe("Query Finder", () => {
  describe("basic detection", () => {
    it("should find a single gql template literal", () => {
      const source = `
import gql from "graphql-tag"
export const Q = gql\`
  query getUser($id: ID!) {
    user(id: $id) { id name }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      expect(templates[0].query).toContain("query getUser")
    })

    it("should find multiple gql template literals", () => {
      const source = `
import gql from "graphql-tag"
export const A = gql\`query a { user { id } }\`
export const B = gql\`query b { project { id } }\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(2)
    })

    it("should return empty array when no gql templates exist", () => {
      const source = `
import React from 'react'
const x = 'hello'
const y = \`template literal without gql\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(0)
    })
  })

  describe("multiline queries", () => {
    it("should extract multiline query content", () => {
      const source = `
const Q = gql\`
  query projectTask($projectTaskId: ID!) {
    projectTask(id: $projectTaskId) {
      id
      canBeEdited
      task {
        id
        code
      }
    }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      expect(templates[0].query).toContain("projectTask")
      expect(templates[0].query).toContain("canBeEdited")
      expect(templates[0].query).toContain("task")
    })
  })

  describe("template position tracking", () => {
    it("should track the start line of the GraphQL content", () => {
      const source = `line0
line1
const Q = gql\`
  query { user { id } }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      expect(templates[0].startLine).toBe(2) // 0-indexed, gql` is on line 2
    })

    it("should track correct start line for second template", () => {
      const source = `import gql from "graphql-tag"

const A = gql\`query a { user { id } }\`

const B = gql\`query b { project { id } }\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(2)
      expect(templates[0].startLine).toBe(2)
      expect(templates[1].startLine).toBe(4)
    })
  })

  describe("interpolations", () => {
    it("should handle ${...} interpolations", () => {
      const source = `
const Q = gql\`
  query {
    user { id name }
  }
  \${fragment}
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      // The interpolation should be replaced with spaces
      expect(templates[0].query).not.toContain("${")
    })
  })

  describe("edge cases", () => {
    it("should handle empty gql template", () => {
      const source = `const Q = gql\`\``
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      expect(templates[0].query).toBe("")
    })

    it("should handle gql with space before backtick", () => {
      const source = `const Q = gql \`query { user { id } }\``
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
    })

    it("should handle queries with GraphQL comments", () => {
      const source = `
const Q = gql\`
  # This is a comment
  query {
    # field comment
    user { id }
  }
\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(1)
      expect(templates[0].query).toContain("# This is a comment")
    })

    it("should not match non-gql template literals", () => {
      const source = `
const x = html\`<div>hello</div>\`
const y = css\`.class { color: red }\`
const z = sql\`SELECT * FROM users\`
`
      const templates = findGraphQLTemplates(source)
      expect(templates).toHaveLength(0)
    })
  })
})
