// Real query from nitro-web: components/installation_scheduler/app/components/ScheduleServiceApp/graphql/queries/project_task.ts
export const PROJECT_TASK_QUERY = `
import gql from "graphql-tag"

export const PROJECT_TASK = gql\`
  query projectTask($projectTaskId: ID!) {
    projectTask(id: $projectTaskId) {
      id
      canBeEdited
      canChangeDuration
      estimatedCompletionAt
      task {
        id
        code
      }
      scheduledDate
      installer {
        id
        crewName
      }
      product {
        id
        code
      }
      project {
        id
        projectNumber
      }
    }
  }
\`
`

// Real query from nitro-web: components/installation_scheduler/app/components/ScheduleServiceApp/graphql/queries/find_service_task.ts
export const FIND_SERVICE_TASK_QUERY = `
import gql from "graphql-tag"

export const FIND_SERVICE_TASK = gql\`
  query findServiceTask($projectId: ID!, $productId: ID!) {
    findServiceTask(projectId: $projectId, productId: $productId) {
      id
    }
  }
\`
`

// A file with multiple queries
export const MULTIPLE_QUERIES = `
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
  query getProject($projectId: ID!) {
    project(id: $projectId) {
      id
      name
      status
    }
  }
\`
`

// Query with interpolation (fragment spread)
export const QUERY_WITH_INTERPOLATION = `
import gql from "graphql-tag"
import { useConnectionQuery } from '@powerhome/nitro_react/graphql'

const TIME_OFF_BALANCE_QUERY = gql\`
  query ($cursor: String, $bucket: String!, $search: Json) {
    timeOffBalance(bucket: $bucket, first: 20, after: $cursor, search: $search) {
      nodes {
        user {
          id
          goesBy
          lastName
        }
        approved
        used
        available
      }
      pageInfo {
        ...ConnectionQueryPageInfo
      }
    }
  }
\${useConnectionQuery.fragments.pageInfo}
\`
`

// Invalid query with bad field
export const INVALID_FIELD_QUERY = `
import gql from "graphql-tag"

export const BAD_QUERY = gql\`
  query badQuery($id: ID!) {
    projectTask(id: $id) {
      id
      nonExistentField
      potato
    }
  }
\`
`

// Source with no gql templates
export const NO_GRAPHQL = `
import React from 'react'

const MyComponent = () => {
  return <div>Hello World</div>
}

export default MyComponent
`

// Malformed GraphQL (parse error)
export const MALFORMED_QUERY = `
import gql from "graphql-tag"

export const BROKEN = gql\`
  query {
    user(id: $id) {
      id
      name
      <<<INVALID>>>
    }
  }
\`
`

// Empty gql template
export const EMPTY_QUERY = `
import gql from "graphql-tag"

export const EMPTY = gql\`\`
`

// Multiline with comments
export const QUERY_WITH_COMMENTS = `
import gql from "graphql-tag"

export const COMMENTED = gql\`
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

// Very deeply nested query
export const DEEPLY_NESTED_QUERY = `
import gql from "graphql-tag"

export const DEEP = gql\`
  query deepQuery($id: ID!) {
    project(id: $id) {
      id
      tasks {
        id
        installer {
          id
          crew {
            id
            members {
              id
              user {
                id
                name
              }
            }
          }
        }
      }
    }
  }
\`
`
