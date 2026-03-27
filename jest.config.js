/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/__tests__"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  moduleNameMapper: {
    "^vscode$": "<rootDir>/__tests__/__mocks__/vscode.ts",
  },
  collectCoverageFrom: ["src/**/*.ts", "!src/extension.ts"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov"],
}
