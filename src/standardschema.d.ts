declare module 'standardschema' {
  type ValidationResult = boolean | { valid?: boolean; errors?: unknown }
  const Standards: {
    validate?: (
      schema: unknown,
      data: unknown
    ) => ValidationResult | Promise<ValidationResult>
    compile?: (
      schema: unknown
    ) => (data: unknown) => ValidationResult | Promise<ValidationResult>
  }
  export default Standards
}
