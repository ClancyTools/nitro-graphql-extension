# Implementation Prompt: Option A - Local Schema Builder Server

## Overview

Replace remote HTTP introspection with a local Node.js schema builder that:

1. Automatically discovers and parses Ruby GraphQL type files
2. Builds a GraphQL schema in-memory without external dependencies
3. Serves introspection queries via local HTTP server
4. Watches for file changes and rebuilds schema
5. Handles field access levels (public/private/partner/custom)
6. Safely caches schema only when validation succeeds

## Context

- **Extension runs in**: `nitro-web` directory (sibling to Rails app)
- **GraphQL files location**: Scattered across `components/*/app/graphql/*/graphql/*.rb` (recursive search required)
- **Access notation examples**:
  - `field :name, String, null: false, access: :public`
  - `field :id, ID, null: false, access: %i[private customer]`
  - `field :name, String, null: false, access: :partner`
  - Missing `access:` = defaults to `:private` (auth required)

## Architecture Changes

### New File Structure

```
src/
├── schema/
│   ├── introspection.ts (MODIFIED - query local server instead)
│   ├── rubySchemaBuilder.ts (NEW - Parse Ruby files → GraphQL schema)
│   ├── localSchemaServer.ts (NEW - HTTP server for introspection)
│   └── schemaManager.ts (MODIFIED - Use local server, remove polling)
└── extension.ts (MODIFIED - Start local server instead of remote fetch)
```

### Module Responsibilities

#### `rubySchemaBuilder.ts` (NEW)

**Purpose**: Parse Ruby GraphQL type definitions and build schema programmatically

**Functions**:

- `findGraphQLDirectories(basePath: string): Promise<string[]>`
  - Recursively search for directories named `graphql`
  - Pattern: `*/graphql/*/graphql/` (from any component)
  - Returns array of absolute paths

- `loadGraphQLTypeFiles(directories: string[]): Promise<Map<string, string>>`
  - Read all `.rb` files from graphql directories
  - Key: filename, Value: file contents
  - Excludes non-.rb files

- `parseRubyTypeDefinition(fileContent: string, fileName: string): GraphQLTypeDefinition`
  - Extract class name from `class XType < ...`
  - Extract fields using regex: `field\s+:(\w+),\s+([^,]+)(?:.*access:\s+([^,)]+))?`
  - Parse access levels: `:public` → `["public"]`, `%i[private customer]` → `["private", "customer"]`, missing → `["private"]`
  - Return: `{ name, fields: [{ name, type, nullable, access }] }`

- `buildGraphQLSchema(typeDefs: GraphQLTypeDefinition[]): GraphQLSchema`
  - Convert parsed Ruby definitions to GraphQL schema object
  - Handle type relationships (if CourseType references VersionType, link them)
  - Return buildable GraphQL schema or throw error if invalid

- `validateSchemaIntegrity(schema: GraphQLSchema): boolean`
  - Check all types have at least one field (catches incomplete schemas)
  - Return true if valid, false otherwise

#### `localSchemaServer.ts` (NEW)

**Purpose**: Run HTTP server that serves introspection queries

**Class**: `LocalSchemaServer`

- **Constructor**: `new LocalSchemaServer(basePath: string, port?: number)`
  - Default port: 9876 (configurable)
  - Store basePath for building schema

- **Methods**:
  - `async start(): Promise<void>`
    - Build initial schema from Ruby files
    - Start HTTP server on specified port
    - Start file watcher on graphql directories
    - Log success/errors

  - `async stop(): Promise<void>`
    - Stop HTTP server
    - Stop file watchers

  - `async rebuildSchema(): Promise<boolean>`
    - Parse all Ruby files
    - Build new schema
    - Validate integrity
    - **On success**: Cache new schema, return true
    - **On error**: Keep old cached schema, log error, return false

  - `async handleIntrospectionQuery(query: string): Promise<IntrospectionQuery>`
    - Execute introspection query against current schema
    - Return result

**HTTP Routes**:

- `POST /graphql` - Accepts GraphQL queries (introspection)
  - Req: `{ query: "...", operationName?: "..." }`
  - Res: `{ data: IntrospectionQuery }` or `{ errors: [...] }`
  - Only supports introspection queries, rejects mutations

**File Watching**:

- Watch all discovered `graphql/*/graphql/` directories
- Debounce 500ms on file changes
- Trigger `rebuildSchema()` when `.rb` files change
- Log changes to Extension Host output

**Error Handling**:

- Parser errors (malformed Ruby): Log, don't update cache
- Schema validation errors: Log specific type/field issues, keep old schema
- Server already running: Don't start twice
- Port already taken: Increment port or fail with clear error

#### `introspection.ts` (MODIFIED)

**Changes**:

- Remove `fetchIntrospection()` function (no longer needed)
- Modify `buildSchemaFromIntrospection()` to accept local schema object
- Add `queryLocalServer(port: number, query: string): Promise<IntrospectionQuery>`
  - HTTP POST to `http://localhost:PORT/graphql`
  - Return parsed introspection result

#### `schemaManager.ts` (MODIFIED)

**Changes**:

- Remove polling logic (schema continuously updated by file watcher)
- Add `localServer: LocalSchemaServer` property
- Modify `initialize()` to:
  - Start local server instead of fetching remote endpoint
  - Handle startup errors gracefully
  - Call status callbacks when schema updates

#### `extension.ts` (MODIFIED)

**Changes**:

- Initialize `LocalSchemaServer` in `activate()`
- Pass base path (workspace root) to server
- Call `server.start()` on activation
- Call `server.stop()` on deactivation
- Remove remote schema fetch logic
- Update `validateDocument()` to work with new schema source

### Configuration

Add new settings to `package.json` contributions:

```json
{
  "nitroGraphql.graphqlSearchPatterns": {
    "type": "array",
    "default": ["**/graphql/*/graphql"],
    "description": "Glob patterns to find GraphQL type directories"
  },
  "nitroGraphql.localServerPort": {
    "type": "number",
    "default": 9876,
    "description": "Port for local schema server"
  }
}
```

---

## Implementation Steps

### Phase 1: Ruby File Parsing

1. Implement `findGraphQLDirectories()` - recursive directory search
2. Implement `loadGraphQLTypeFiles()` - read .rb files
3. Implement `parseRubyTypeDefinition()` - extract fields + access levels
4. **Tests**:
   - Parse standard field definitions
   - Handle all access level formats (:public, %i[...], missing)
   - Handle multiline field definitions
   - Handle edge cases (escaped strings, comments)

### Phase 2: Schema Builder

1. Implement `buildGraphQLSchema()` - convert parsed defs to GraphQL schema
2. Implement `validateSchemaIntegrity()` - check for empty types
3. **Tests**:
   - Build valid schema from parsed definitions
   - Catch validation errors
   - Handle circular type references
   - Reject schemas with empty types

### Phase 3: Local Server

1. Implement `LocalSchemaServer` class
2. Implement HTTP server with `/graphql` endpoint
3. Implement file watching and rebuildSchema
4. Implement error recovery (keep old schema on parse errors)
5. **Tests**:
   - Server starts/stops correctly
   - Handles introspection queries
   - File changes trigger rebuilds
   - Invalid schemas don't corrupt cache
   - Port conflicts handled

### Phase 4: Integration

1. Update `introspection.ts` to query local server
2. Update `schemaManager.ts` to start local server
3. Update `extension.ts` activation/deactivation
4. Add configuration UI for port/patterns
5. **Tests**:
   - Extension starts server on activation
   - Server serves introspection queries
   - Full validation workflow works end-to-end
   - Graceful shutdown

### Phase 5: Testing

Update existing tests:

- `schemaManager.test.ts` - Mock LocalSchemaServer instead of fetch
- `validation.test.ts` - Test with local schema
- Add new test files:
  - `rubySchemaBuilder.test.ts` - 20+ tests for parsing/building
  - `localSchemaServer.test.ts` - 15+ tests for server/watching

---

## Key Requirements

1. **File Discovery**:
   - Search recursively from workspace root
   - Match pattern: `*/graphql/*/graphql/*.rb`
   - Handle components at any nesting level

2. **Field Parsing**:
   - Extract: `field :<name>, <type>, [options]`
   - Options include: `null:`, `access:`, others (ignore)
   - Handle multiline definitions
   - Ignore comments and strings

3. **Access Levels**:
   - `:public` → `["public"]`
   - `:private` → `["private"]`
   - `:partner` → `["partner"]`
   - `%i[private customer]` → `["private", "customer"]`
   - Missing `access:` → `["private"]` (default)
   - Store on schema for potential future validation

4. **Schema Safety**:
   - Only update cache on successful schema validation
   - Keep previous valid schema if new parse fails
   - Log all errors to Extension Host output
   - Never crash extension due to schema errors

5. **Performance**:
   - Schema building should complete < 2s for first parse
   - File watching debounce: 500ms
   - Server startup should not block extension activation

6. **Error Scenarios**:
   - No graphql directories found → Log warning, continue
   - Malformed Ruby file → Log error with file path, skip file
   - Circular type references → Handle gracefully in schema
   - Server port taken → Try successive ports or fail clearly

---

## Success Criteria

- ✅ Extension activates and starts local schema server
- ✅ Local server discovers all Ruby GraphQL files
- ✅ Schema parses correctly (no empty types)
- ✅ Introspection queries work against local schema (no auth required)
- ✅ All 71 existing tests still pass
- ✅ New tests for schema builder (20+ tests)
- ✅ New tests for local server (15+ tests)
- ✅ File changes trigger immediate schema rebuild
- ✅ Invalid schema doesn't corrupt cache
- ✅ Access levels stored and accessible for future validation
- ✅ Extension works "out of the box" with no configuration needed

---

## Notes for Implementation

- Language: TypeScript (existing codebase uses TS)
- Bundled: Will be included in esbuild bundle (no npm package parsing)
- Testing: Jest with mocked fs/watchers
- Backwards compatibility: Remove all remote schema fetch code
- Documentation: Update README with new architecture
