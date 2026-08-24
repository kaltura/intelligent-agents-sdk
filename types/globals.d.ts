// Ambient decls for the couple of Node-only globals used in src/ (Buffer, atob).
// Deliberately NOT `@types/node`: that package's legacy `punycode`/`string_decoder`
// ambient module shims collide with same-named real packages hoisted into
// node_modules by other devDependencies, making tsc typecheck their bundled
// implementation .js files as if they were part of this program.
declare const Buffer: {
  from(input: string, encoding?: string): { toString(encoding?: string): string };
  isBuffer(x: unknown): boolean;
};
declare function atob(data: string): string;

// The DOM lib types setTimeout/setInterval's return as `number` (browser signature); this
// SDK also runs under Node, where the real return is a Timeout object with `.unref()`. Every
// call site already guards with `.unref?.()`, so this augmentation only widens the TYPE to
// match that already-safe runtime pattern — it adds nothing at runtime (interface merging
// on a primitive wrapper type has no runtime effect).
interface Number {
  unref?(): void;
}
