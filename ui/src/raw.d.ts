// Files imported as text through Vite's ?raw suffix, such as the changelog.
declare module "*?raw" {
  const text: string;
  export default text;
}
