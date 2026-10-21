---
root: true
targets: ["*"]
description: "Project overview and general development guidelines"
globs: ["**/*"]
---

# Project Overview

## General Guidelines

- Write all code in JavaScript as ES modules (Node 20.6 or later, `"type": "module"`); there is no TypeScript and no build step
- Document shapes with JSDoc where it helps, not with a type system
- Follow consistent naming conventions
- Write self-documenting code with clear variable and function names
- Prefer composition over inheritance
- Use meaningful comments for complex business logic

## Code Style

- Use 2 spaces for indentation
- Use semicolons
- Use double quotes for strings
- Use trailing commas in multi-line objects and arrays
- Lint with ESLint (`npm run lint`) and write commits as conventional commits (commitlint)

## Tests

- Tests use the built-in runner: `node --test`, with `node:assert/strict` and no test framework
- Run the whole suite from the repository root with `npm test` (it includes the end-to-end tests)

## Architecture Principles

- Organize code by feature, not by file type
- Keep related files close together
- Use dependency injection for better testability
- Implement proper error handling
- Follow single responsibility principle
