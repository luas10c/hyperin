import { defineConfig, globalIgnores } from 'eslint/config'

import globals from 'globals'

import js from '@eslint/js'

import ts from 'typescript-eslint'

import prettier from 'eslint-plugin-prettier'

import jest from 'eslint-plugin-jest'

export default defineConfig([
  globalIgnores(['node_modules', 'dist', 'coverage']),
  js.configs.recommended,
  ts.configs.recommended,
  {
    name: 'prettier/recommended',
    plugins: {
      prettier
    },
    languageOptions: {
      globals: {
        ...globals.es2022,
        ...globals.node
      }
    },
    rules: {
      ...prettier.configs.recommended.rules
    }
  },
  {
    name: 'jest/recommended',
    files: ['**/*.{test,spec}.ts'],
    ...jest.configs['flat/recommended']
  }
])
