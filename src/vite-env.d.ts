/// <reference types="vite/client" />

declare const __EVIDENCE_BUILD_IDENTITY__: Readonly<
  import('./evidence/types').EvidenceBuildIdentity
>;

declare module '*.csv?raw' {
  const value: string;
  export default value;
}
