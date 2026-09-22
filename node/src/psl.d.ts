// psl ships types, but its package.json "exports" hides them from NodeNext resolution
declare module 'psl' {
  export function get(domain: string): string | null;
}
