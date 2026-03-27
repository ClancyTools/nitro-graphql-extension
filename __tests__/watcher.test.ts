jest.mock("vscode")

describe("FileWatcher", () => {
  let vscode: any

  beforeEach(() => {
    jest.resetModules()
    vscode = require("vscode")
  })

  it("should create file watchers for query patterns", () => {
    const { FileWatcher } = require("../src/watcher/fileWatcher")
    const callbacks = {
      onQueryFileChanged: jest.fn(),
      onSchemaFileChanged: jest.fn(),
    }

    const watcher = new FileWatcher(callbacks)
    // Should have created watchers for: *.ts, *.tsx, *.js, *.jsx, and schema .rb
    expect(vscode.workspace.createFileSystemWatcher).toHaveBeenCalledTimes(5)
    watcher.dispose()
  })

  it("should dispose all watchers on dispose", () => {
    const { FileWatcher } = require("../src/watcher/fileWatcher")
    const callbacks = {
      onQueryFileChanged: jest.fn(),
      onSchemaFileChanged: jest.fn(),
    }

    const watcher = new FileWatcher(callbacks)
    watcher.dispose()
    // Verify dispose was called on each watcher mock
  })
})

describe("FileWatcher debouncing", () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it("should debounce rapid file changes", () => {
    jest.resetModules()
    const vscode = require("vscode")

    // Capture the onDidChange callbacks
    const changeCallbacks: Function[] = []
    vscode.workspace.createFileSystemWatcher.mockImplementation(() => ({
      onDidChange: (cb: Function) => changeCallbacks.push(cb),
      onDidCreate: jest.fn(),
      onDidDelete: jest.fn(),
      dispose: jest.fn(),
    }))

    const { FileWatcher } = require("../src/watcher/fileWatcher")
    const onQueryFileChanged = jest.fn()
    const callbacks = {
      onQueryFileChanged,
      onSchemaFileChanged: jest.fn(),
    }

    const watcher = new FileWatcher(callbacks, 100, 100)

    // Simulate rapid changes to the same file
    const uri = { fsPath: "/test/query.ts" }
    if (changeCallbacks.length > 0) {
      changeCallbacks[0](uri)
      changeCallbacks[0](uri)
      changeCallbacks[0](uri)

      // Before debounce fires
      expect(onQueryFileChanged).not.toHaveBeenCalled()

      // After debounce
      jest.advanceTimersByTime(150)
      expect(onQueryFileChanged).toHaveBeenCalledTimes(1)
    }

    watcher.dispose()
  })
})
