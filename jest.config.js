/** @type{import('jest').Config} */
export default {
  projects: [
    {
      displayName: 'unit',
      testMatch: ['<rootDir>/tests/unit/**/*.spec.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
      transform: {
        '^.+\\.(t|j)sx?$': '@swc/jest'
      },
      moduleNameMapper: {
        '#^(.+)$': '<rootDir>/src/$1'
      }
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/tests/integration/**/*.spec.ts'],
      setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
      testEnvironment: 'node',
      transform: {
        '^.+\\.(t|j)sx?$': '@swc/jest'
      },
      moduleNameMapper: {
        '#^(.+)$': '<rootDir>/src/$1'
      }
    }
  ]
}
