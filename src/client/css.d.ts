// Vite handles a CSS import at build time (extracting it into its own stylesheet); TypeScript
// just needs to know the module specifier resolves to something.
declare module '*.css'
