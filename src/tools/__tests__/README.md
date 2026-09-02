Depending on which testing framework you're using (Jest, Vitest, Playwright, or Mocha), here is how you run a single specific test file located inside a folder.

---

### 1. Jest or Vitest

Both Jest and Vitest filter by file path automatically when you pass a path to the command:

```bash
# Using npm
npm test -- path/to/folder/my-test.test.ts

# Using npx directly
npx jest path/to/folder/my-test.test.ts
# OR
npx vitest path/to/folder/my-test.test.ts

```

### 2. Playwright

For Playwright, pass the relative path directly to the test command:

```bash
npx playwright test path/to/folder/my-test.spec.ts

```

### 3. Mocha (with `ts-node`)

```bash
npx mocha -r ts-node/register path/to/folder/my-test.test.ts

```

---

### Pro Tip: Run just ONE test block *inside* that file

If your file has multiple tests (`it` or `test` blocks) and you only want to execute **a single specific test case**, you don't need to type out long flags. Just add `.only` in your TypeScript code:

```typescript
// Only this test will run when you execute the file
it.only('should process payment correctly', () => {
  // ...
});

// This test will be skipped
it('should fail on invalid card', () => {
  // ...
});

```

*(Remember to remove `.only` before pushing your code!)*



To run **all tests** inside a specific directory/folder, you pass the folder path (or a glob pattern matching that folder) to your test runner:

---

### 1. Jest or Vitest

Both toolchains treat path arguments as positional filters. Passing the directory name will execute all tests inside it and any subfolders:

```bash
# Using npm
npm test -- path/to/folder

# Using npx directly
npx jest path/to/folder
# OR
npx vitest run path/to/folder

```

---

### 2. Playwright

Pass the relative folder path directly:

```bash
npx playwright test path/to/folder

```

---

### 3. Mocha

Mocha requires a glob pattern to match all test files within a directory recursively:

```bash
npx mocha -r ts-node/register "path/to/folder/**/*.spec.ts"

```

---

> **Tip:** If your folder path contains spaces or special characters, make sure to wrap the path in quotes (e.g., `"src/features/user authentication"`).