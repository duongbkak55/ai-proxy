declare module "safe-regex" {
  function safeRegex(re: RegExp | string): boolean;
  export default safeRegex;
}
