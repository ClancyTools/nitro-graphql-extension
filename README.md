# Nitro GraphQL Validator

Real-time GraphQL query/mutation validation for nitro-web's CoBRA (Component-Based Rails Architecture). Validates `gql` template literals in TypeScript/JavaScript files against the Rails GraphQL schema.

## Features

- **Real-time validation** — Red squiggle underlines on invalid fields, variables, and type mismatches in `gql` template literals
- **Semantic syntax highlighting** — Color-coded syntax for queries, mutations, fields (nested vs. root-level), variables, types, and more. Distinguishes between operation types and fragments for better visual clarity
- **Rich hover information** — Hover over any field to see:
  - Field type and nullability
  - Full field description if defined
  - Parent type context
  - For list fields: base type name and description (e.g., hover over `items: [Item!]` shows the `Item` type description)
  - For root fields (queries/mutations): resolver class name with a clickable link to open the resolver file, access levels, and arguments
  - For nested fields: all arguments with their types and default values
- **Schema introspection** — Fetches schema from your local Rails GraphQL endpoint via introspection
- **Cached fallback** — Falls back to last-known-good cached schema when the Rails server is unavailable
- **File watching** — Watches `.rb` GraphQL definition files and re-fetches schema on changes
- **Autocomplete for fields** — Type suggestions for fields and arguments as you write queries, with inline snippets for required arguments and nested selections
- **Error tooltips** — Hover over validation errors for human-readable explanations
- **Quick fixes** — Suggests similar field names when you misspell one
- **Status bar** — Shows current schema status (Ready / Cached / Loading / Error) with type count and schema memory usage

## Configuration

Open VS Code settings and search for "Nitro GraphQL":

| Setting | Default | Description |
| --------- | --------- | ------------- |
| `nitroGraphql.endpoint` | `http://localhost:3000/graphql` | GraphQL endpoint URL |
| `nitroGraphql.enabled` | `true` | Enable/disable the extension |
| `nitroGraphql.watchRubyFiles` | `true` | Watch `.rb` files for schema changes |

## Commands

Open the Command Palette (`Cmd+Shift+P`) and type:

- **Nitro GraphQL: Refresh Schema** — Re-fetch the schema from the Rails endpoint
- **Nitro GraphQL: Clear Cache** — Clear the cached schema
- **Nitro GraphQL: Show Schema Status** — Show current schema status

## How It Works

1. On activation, the extension fetches the GraphQL schema via introspection from your local Rails server
2. It watches `.ts`, `.tsx`, `.js`, `.jsx` files for `gql` template literals
3. Each query is parsed and validated against the schema using `graphql-js`
4. Validation errors are mapped back to the original file positions and shown as VS Code diagnostics
5. Schema is cached to `~/.cache/nitro-graphql-validator/schema.json` for offline use

## Troubleshooting

**Schema not loading?**

- Ensure your Rails server is running at the configured endpoint
- Check the Output panel (View → Output → select "Nitro GraphQL") for errors
- Try the "Refresh Schema" command

**No validation appearing?**

- Ensure the file is TypeScript or JavaScript (check language mode in status bar)
- Ensure the extension is enabled (`nitroGraphql.enabled: true`)
- Check that you're using `gql` template literals (e.g., `` gql`query { ... }` ``)

**Stale schema?**

- Use "Refresh Schema" command to force a re-fetch
- Use "Clear Cache" if the cached schema is corrupt

## Development

```bash
npm install          # Install dependencies
npm run compile      # Build the extension
npm run watch        # Build in watch mode
npm test             # Run the test suite
```

### Running the Extension Locally

To test the extension during development, use the **Run Extension** debug configuration (`F5`). This will launch a VS Code instance with the extension and open the `nitro-web` project for testing.

By default, the launch configuration expects `nitro-web` to be a sibling directory to this extension. If your setup is different, you can modify the path in `.vscode/launch.json` or set the `NITRO_WEB_PATH` environment variable before launching.

Once the extension is installed by users, it will work on any project they have open in VS Code — no additional configuration needed.

## Testing

The test suite covers:

- **Schema loading & caching** — Introspection, fallback, cache read/write
- **Query parsing** — Template literal detection, multiline, interpolations
- **Validation** — Valid/invalid queries, error location mapping
- **Diagnostics** — Error reporting, hover messages, code actions
- **File watching** — Debouncing, change detection
- **Performance** — Validation speed, memory usage
- **Edge cases** — Malformed GraphQL, empty queries, unicode
